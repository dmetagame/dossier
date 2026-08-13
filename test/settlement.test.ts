// The paid path, end to end, against a sandbox facilitator.
//
// Every other test file runs with DEV_SKIP_PAYMENT=1, which removes the x402
// middleware entirely. That left the single most expensive part of this service
// — the code that decides whether a buyer is charged — covered by nothing but a
// reading of the SDK's source. This file runs the real middleware, the real
// `x402ResourceServer`, the real `ExactEvmScheme` and the real
// `OKXFacilitatorClient`, and replaces only the thing at the far end of the
// wire: OKX itself.
//
// The facilitator is stubbed at `fetch`, not run as a local server, and no
// credentials are involved. That is deliberate. A "sandbox" built from live OKX
// keys would put a settlement credential into CI, which is a worse exposure than
// the bug class these tests catch.
//
// WHAT THIS PROVES: that we build a well-formed challenge, that we match a
// buyer's payload to our own requirements, that verify happens before the
// handler and settle after it, that a non-2xx never reaches settle, that the
// receipt is linked to the archived report, and what a buyer actually receives
// when settlement fails after their report has already been built.
//
// WHAT IT DOES NOT PROVE: that OKX accepts our credentials, that our HMAC
// signing is right, or that USD₮0 actually moves. Nothing that runs offline can
// prove those. They are proved by real purchases against production, of which
// there have been three.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { x402HTTPResourceServer } from "@okxweb3/x402-hono";
import { stubUpstream, tempArchive, ADDR } from "./helpers";
import { archiveRecordMac } from "../src/dossier/archive-format";

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;

// The paid middleware is mounted at import time, and only when payment is
// configured and dev-skip is off. `pnpm test` sets DEV_SKIP_PAYMENT=1 for every
// other file, so it has to come off here before src/app is loaded.
delete process.env.DEV_SKIP_PAYMENT;
process.env.PAY_TO = "0x51c25782af63381056cd1c3c59c0544628d67697";
process.env.OKX_API_KEY = "sandbox-key-not-a-credential";
process.env.OKX_SECRET_KEY = "sandbox-secret-not-a-credential";
process.env.OKX_PASSPHRASE = "sandbox-passphrase-not-a-credential";
process.env.PUBLIC_ORIGIN = "https://dossier.example";
process.env.PAYMENT_REPLAY_KEY = "sandbox-payment-replay-key";
process.env.ARCHIVE_MAC_KEY = "sandbox-archive-mac-key";
process.env.ARCHIVE_MAC_REQUIRED = "1";

const NETWORK = "eip155:196";
const PAYER = "0x00000000000000000000000000000000000000ff";
const FACILITATOR = "https://web3.okx.com/api/v6/pay/x402/";

type Op = "supported" | "verify" | "settle";

/**
 * A facilitator we control, so the tests can ask what happens on each of its
 * answers. `calls` is the record of what the resource server actually asked it
 * for, which is where the ordering assertions come from.
 */
const fac = {
  calls: [] as { op: Op; body?: any }[],
  verifyValid: true,
  verifyReason: "invalid_exact_evm_payload_authorization_valid_before",
  settleOk: true,
  settleReason: "insufficient_funds",
  settleFailureWithTx: false,
  settleStatus: undefined as "pending" | "success" | "timeout" | undefined,
  settleStatusResult: undefined as "pending" | "success" | "failed" | undefined,
  settleStatusTransaction: undefined as string | undefined,
  settleStatusNetwork: undefined as string | undefined,
  settleStatusPayer: undefined as string | undefined,
  settleStatusOmitPayer: false,
  settleStatusDown: false,
  settleStatusCalls: 0,
  settleNetwork: NETWORK,
  settleAmount: undefined as string | undefined,
  /**
   * Make a call unreachable, as an outage, a revoked key or a 500 would. This
   * is not the same as the facilitator answering "no", and the service must not
   * treat it as though it were.
   */
  down: false,
  settleDown: false,
  /** Archive size observed at the moment settle was called. */
  archivedAtSettle: -1,
  /** Report id already committed to replay state when settlement begins. */
  replayReportAtSettle: undefined as string | undefined,
  /** Test-only hook after the pending replay/report is visible at settle. */
  beforeSettleResponse: undefined as (() => void) | undefined,
  /**
   * A fresh transaction per test. The archive is keyed on this, and reusing one
   * hash made a later test recover an earlier test's report, which is the same
   * confusion a real collision would cause.
   */
  tx: "",
  reset() {
    this.calls = [];
    this.verifyValid = true;
    this.settleOk = true;
    this.settleFailureWithTx = false;
    this.settleStatus = undefined;
    this.settleStatusResult = undefined;
    this.settleStatusTransaction = undefined;
    this.settleStatusNetwork = undefined;
    this.settleStatusPayer = undefined;
    this.settleStatusOmitPayer = false;
    this.settleStatusDown = false;
    this.settleStatusCalls = 0;
    this.settleNetwork = NETWORK;
    this.settleAmount = undefined;
    this.down = false;
    this.settleDown = false;
    this.archivedAtSettle = -1;
    this.replayReportAtSettle = undefined;
    this.beforeSettleResponse = undefined;
    this.tx = "0x" + randomBytes(32).toString("hex");
    paymentSerial++;
  },
  ops(): Op[] {
    return this.calls.map((c) => c.op);
  },
};

let paymentSerial = 0;

const archivedCount = () =>
  readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .length;

const replayStateForReport = (reportId: string): string | undefined =>
  readdirSync(dir)
    .filter((name) => name.startsWith(".payment-") && name.endsWith(".state"))
    .find((name) => {
      try {
        return JSON.parse(readFileSync(`${dir}/${name}`, "utf8")).reportId === reportId;
      } catch {
        return false;
      }
    });

const canonicalReplayValue = (value: any): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalReplayValue).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, item]) => `${JSON.stringify(name)}:${canonicalReplayValue(item)}`)
    .join(",")}}`;
};

const replayMacKey = () =>
  createHash("sha256")
    .update(`dossier-payment-replay:${process.env.PAYMENT_REPLAY_KEY}`)
    .digest();

function restoreReplayHold(state: {
  reportId: string;
  fingerprint: string;
  attemptToken: string;
}): void {
  const unsigned = {
    v: 1,
    reportId: state.reportId,
    fingerprint: state.fingerprint,
    attemptToken: state.attemptToken,
  };
  const mac = createHmac("sha256", replayMacKey())
    .update(canonicalReplayValue(unsigned))
    .digest("hex");
  writeFileSync(
    `${dir}/.report-${state.reportId.toLowerCase()}.replay-hold`,
    JSON.stringify({ ...unsigned, mac }),
  );
}

const json = (data: unknown) =>
  new Response(JSON.stringify({ code: "0", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const originalProcessHTTPRequest = x402HTTPResourceServer.prototype.processHTTPRequest;
let failBeforeHandler = 0;
x402HTTPResourceServer.prototype.processHTTPRequest = async function (...args) {
  const result = await originalProcessHTTPRequest.apply(this, args);
  if (failBeforeHandler > 0 && result.type === "payment-verified") {
    failBeforeHandler--;
    throw new Error("simulated cold-start failure before handler dispatch");
  }
  return result;
};

// Installed before src/app is imported, because the module kicks off the
// facilitator handshake as it loads. Non-facilitator traffic is handed to the
// upstream fixture stub, which is installed later in `before()` and captured
// here through a mutable binding for exactly that reason.
let upstream: typeof fetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
  if (!url.startsWith(FACILITATOR)) return upstream(input, init);

  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  if (url.endsWith("/supported")) {
    fac.calls.push({ op: "supported" });
    return json({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
      extensions: [],
      signers: {},
    });
  }

  if (url.endsWith("/verify")) {
    fac.calls.push({ op: "verify", body });
    if (fac.down) throw new Error("simulated facilitator outage");
    return json(
      fac.verifyValid
        ? { isValid: true, payer: PAYER }
        : { isValid: false, invalidReason: fac.verifyReason, payer: PAYER },
    );
  }

  if (url.includes("/settle/status?")) {
    fac.settleStatusCalls++;
    if (fac.settleStatusDown) throw new Error("simulated settlement status outage");
    return json({
      success: fac.settleStatusResult !== "failed",
      status: fac.settleStatusResult ?? "pending",
      transaction: fac.settleStatusTransaction ?? fac.tx,
      network: fac.settleStatusNetwork ?? fac.settleNetwork,
      ...(!fac.settleStatusOmitPayer
        ? { payer: fac.settleStatusPayer ?? PAYER }
        : {}),
    });
  }

  if (url.endsWith("/settle")) {
    fac.calls.push({ op: "settle", body });
    if (fac.settleDown) throw new Error("simulated facilitator outage during settle");
    // Read at the moment money would move. The handler archives before it
    // responds, so a report that exists here is one the buyer is about to get.
    fac.archivedAtSettle = archivedCount();
    const pendingReplay = readdirSync(dir)
      .filter((name) => name.startsWith(".payment-") && name.endsWith(".state"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as {
            status?: string;
            reportId?: string;
          };
        } catch {
          return null;
        }
      })
      .find((state) => state?.status === "pending" && state.reportId);
    fac.replayReportAtSettle = pendingReplay?.reportId;
    fac.beforeSettleResponse?.();
    return json(
      fac.settleOk
        ? {
            success: true,
            status: fac.settleStatus ?? "success",
            transaction: fac.tx,
            network: fac.settleNetwork,
            payer: PAYER,
            ...(fac.settleAmount !== undefined ? { amount: fac.settleAmount } : {}),
          }
        : {
            success: false,
            ...(fac.settleStatus ? { status: fac.settleStatus } : {}),
            errorReason: fac.settleReason,
            errorMessage: "settlement failed on chain",
            transaction: fac.settleFailureWithTx ? fac.tx : "",
            network: fac.settleNetwork,
            payer: PAYER,
          },
    );
  }

  throw new Error(`unstubbed facilitator call: ${url}`);
}) as typeof fetch;

const { app, paymentLayerState } = await import("../src/app");
const archive = await import("../src/dossier/archive");
const paymentReplay = await import("../src/payment-replay");
const ratelimit = await import("../src/ratelimit");

const b64 = {
  encode: (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64"),
  decode: (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")),
};

/** The challenge, exactly as a buyer's client reads it off the 402. */
async function challenge(path = `/dossier?tokenAddress=${ADDR.cake}`) {
  const r = await app.request(path);
  assert.equal(r.status, 402, "an unpaid call must be answered 402");
  const header = r.headers.get("payment-required");
  assert.ok(header, "the 402 must carry a PAYMENT-REQUIRED header");
  return { res: r, required: b64.decode(header!) };
}

/**
 * A payment payload built the way a buyer's client builds one: the `accepted`
 * block is the server's own requirement, echoed back verbatim. The inner
 * `payload` is shaped like a real exact-EVM authorization but its signature is
 * not checked here, because the component that checks it is the facilitator,
 * and in production that is OKX.
 */
function payment(required: any) {
  return b64.encode({
    x402Version: 2,
    accepted: required.accepts[0],
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: {
        from: PAYER,
        to: required.accepts[0].payTo,
        value: required.accepts[0].amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: "0x" + paymentSerial.toString(16).padStart(64, "0"),
      },
    },
  });
}

const paidRequest = async (
  path: string,
  sig: string,
  init: RequestInit = {},
) =>
  app.request(path, {
    ...init,
    headers: { ...(init.headers as any), "payment-signature": sig },
  });

let restore: () => void;
before(async () => {
  const sandbox = globalThis.fetch;
  restore = stubUpstream();
  upstream = globalThis.fetch;
  globalThis.fetch = sandbox;

  // The handshake retries with backoff and never rejects, so this waits for it
  // rather than assuming it has finished.
  for (let i = 0; i < 100 && paymentLayerState() !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(paymentLayerState(), "ready", "the sandbox facilitator must come up");
});
after(() => {
  x402HTTPResourceServer.prototype.processHTTPRequest = originalProcessHTTPRequest;
  restore();
  globalThis.fetch = upstream;
  cleanup();
});
beforeEach(() => {
  fac.reset();
  archive.resetIndex();
  ratelimit.reset();
});

describe("the payment challenge", () => {
  test("successful facilitator initialization is observable and ready", async () => {
    const response = await app.request("/health/ready");
    assert.equal(response.status, 200);
    const health = (await response.json()) as Record<string, unknown>;
    assert.equal(health.ready, true);
    assert.equal(health.paymentLayer, "ready");
    assert.ok(Number(health.facilitatorInitAttempts) >= 1);
    assert.match(
      String(health.facilitatorLastSuccessAt),
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  test("an unpaid call is answered 402 and quotes the real price and asset", async () => {
    const { res, required } = await challenge();
    assert.equal(required.x402Version, 2);
    const a = required.accepts[0];
    assert.equal(a.scheme, "exact");
    assert.equal(a.network, NETWORK);
    assert.equal(a.payTo.toLowerCase(), process.env.PAY_TO!.toLowerCase());
    // $0.01 of a six-decimal stablecoin. A challenge that quotes the wrong
    // number is the one bug here that costs real money in either direction.
    assert.equal(a.amount, "10000");
    assert.equal(required.resource.url, "https://dossier.example/dossier");

    // The body still answers a caller that cannot pay, which is what a
    // marketplace validator and a cold agent both do first.
    const body = (await res.json()) as any;
    assert.equal(body.error, "Payment required");
    assert.ok(body.input, "the parameter contract must be in the unpaid body");
    assert.ok(body.try_before_paying.sample_report.endsWith("/dossier/sample"));
  });

  test("no report is built for an unpaid call", async () => {
    const before = archivedCount();
    await challenge();
    assert.equal(archivedCount(), before, "a 402 must not archive anything");
    assert.deepEqual(fac.ops(), [], "and must not talk to the facilitator");
  });

  test("an oversized payment authorization is rejected before SDK decoding", async () => {
    const before = archivedCount();
    const r = await app.request(`/dossier?tokenAddress=${ADDR.cake}`, {
      headers: { "payment-signature": "a".repeat(16 * 1024 + 1) },
    });
    assert.equal(r.status, 431);
    assert.equal((await r.json() as any).error, "payment_header_too_large");
    assert.deepEqual(fac.ops(), [], "the facilitator never sees the oversized header");
    assert.equal(archivedCount(), before);
  });

  test("new or invalid signed attempts are bounded, while an exact retry remains reachable", async () => {
    const path = `/dossier?tokenAddress=${ADDR.cake}`;
    const buyerPeer = "198.51.100.10";
    const exhaustedPeer = "203.0.113.10";

    // Establish a real, confirmed replay owner from a different client before
    // exhausting the second client's public challenge budget.
    const unpaid = await app.request(path, {
      headers: { "x-forwarded-for": buyerPeer },
    });
    assert.equal(unpaid.status, 402);
    const required = b64.decode(unpaid.headers.get("payment-required")!);
    const signed = payment(required);
    const first = await paidRequest(path, signed, {
      headers: { "x-forwarded-for": buyerPeer },
    });
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const facilitatorCalls = fac.ops().length;

    // Fill the exhausted client's bucket with unsigned challenges. These do
    // not enter the payment/replay layer, so the next signed attempt can prove
    // the limiter decision without adding facilitator calls or state files.
    for (let i = 0; i < ratelimit.limits["/dossier"]!.max; i++) {
      const challengeResponse = await app.request(path, {
        headers: { "x-forwarded-for": exhaustedPeer },
      });
      assert.equal(challengeResponse.status, 402);
    }

    const beforeFiles = readdirSync(dir).sort();
    const beforeVersion = archive.readinessVersionForTests();
    const invalid = await app.request(path, {
      headers: {
        "x-forwarded-for": exhaustedPeer,
        "payment-signature": "not-a-payment",
      },
    });
    assert.equal(invalid.status, 429);
    assert.equal(
      fac.ops().length,
      facilitatorCalls,
      "a novel signed attempt must be rejected before facilitator verification",
    );
    assert.deepEqual(
      readdirSync(dir).sort(),
      beforeFiles,
      "the limiter must reject new signed attempts before replay state churn",
    );
    assert.equal(
      archive.readinessVersionForTests(),
      beforeVersion,
      "a rejected signed flood must not invalidate the durability scan",
    );

    const retry = await paidRequest(path, signed, {
      headers: { "x-forwarded-for": exhaustedPeer },
    });
    assert.equal(retry.status, 200);
    assert.equal(await retry.text(), firstBody);
    assert.equal(
      fac.ops().length,
      facilitatorCalls,
      "an exact durable retry bypasses the limiter without re-verifying or settling",
    );
  });

  test("a valid-shaped payment rejected by the facilitator leaves no replay or cache churn", async () => {
    const path = `/dossier?tokenAddress=${ADDR.cake}`;
    const { required } = await challenge(path);
    const beforeFiles = readdirSync(dir).sort();
    const beforeVersion = archive.readinessVersionForTests();
    fac.verifyValid = false;

    const rejected = await paidRequest(path, payment(required));
    assert.equal(rejected.status, 402);
    assert.deepEqual(fac.ops(), ["verify"]);
    assert.deepEqual(
      readdirSync(dir).sort(),
      beforeFiles,
      "signature verification must happen before replay ownership is published",
    );
    assert.equal(
      archive.readinessVersionForTests(),
      beforeVersion,
      "a rejected signature must not invalidate the cached durability scan",
    );
  });
});

describe("a paid call", () => {
  test("returns the report and settles exactly once, after the report exists", async () => {
    const { required } = await challenge();
    const before = archivedCount();

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("<html"), "the buyer gets the document");
    assert.ok(html.toLowerCase().includes(ADDR.cake), "for the token they asked about");

    // Verify before the handler, settle after it, once each.
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
    // The report was archived before money moved, so a settled payment always
    // has a document behind it.
    assert.equal(fac.archivedAtSettle, before + 1);
    assert.match(
      fac.replayReportAtSettle ?? "",
      /^[a-z0-9-]{8,64}$/i,
      "settlement must not begin until replay state points at the staged report",
    );
    assert.ok(
      readdirSync(dir).includes(`${fac.replayReportAtSettle}.json`),
      "the replay pointer visible at settle must resolve to the staged archive record",
    );

    const receipt = b64.decode(r.headers.get("payment-response")!);
    assert.equal(receipt.success, true);
    assert.equal(receipt.transaction, fac.tx);
  });

  test("the settlement receipt is linked to the report, and recovers it", async () => {
    const { required } = await challenge();
    const paid = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    const document = await paid.text();

    const rec = await app.request("/dossier/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentTransaction: fac.tx }),
    });
    assert.equal(rec.status, 200, "the payer can fetch their report again");
    const body = (await rec.json()) as any;
    assert.equal(body.status, "recovered");
    assert.equal(body.paymentTransaction, fac.tx);
    assert.equal(body.contentType, "text/html");
    assert.equal(
      body.deliverable,
      document,
      "recovery returns the same bytes the buyer was sent, not a rebuild",
    );

    const stored = archive.byTransaction(fac.tx);
    assert.deepEqual(
      stored?.settlement,
      {
        status: "confirmed",
        transaction: fac.tx,
        network: NETWORK,
        payer: PAYER,
      },
      "new recovery records explicitly state that settlement was confirmed",
    );
  });

  test("the payload must match our own requirements", async () => {
    const { required } = await challenge();
    // A buyer who signs for a cheaper price than the one quoted.
    const tampered = JSON.parse(JSON.stringify(required));
    tampered.accepts[0].amount = "1";
    const r = await paidRequest(
      `/dossier?tokenAddress=${ADDR.cake}`,
      payment(tampered),
    );
    assert.equal(r.status, 402, "an underpayment is not a payment");
    assert.deepEqual(fac.ops(), [], "and is refused before the facilitator is asked");
  });

  test("a replay of the same payment returns the original archived bytes", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    const firstBody = await first.text();
    const firstRecord = archive.byTransaction(fac.tx);
    assert.ok(firstRecord);
    const count = archivedCount();

    const second = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), firstBody, "a retry gets exactly the first delivery");
    assert.equal(archive.byTransaction(fac.tx)?.id, firstRecord!.id);
    assert.equal(archivedCount(), count, "the discarded replay does not consume archive space");
    assert.deepEqual(
      fac.ops(),
      ["verify", "settle"],
      "a finalized replay is served before facilitator verification can reject its used nonce",
    );
  });

  test("a durable exact retry bypasses an exhausted public challenge budget", async () => {
    const path = `/dossier?tokenAddress=${ADDR.cake}`;
    const { required } = await challenge(path);
    const sig = payment(required);
    const first = await paidRequest(path, sig);
    assert.equal(first.status, 200);
    const delivered = await first.text();
    const operations = fac.ops().length;

    const peer = "203.0.113.77";
    for (let i = 0; i < ratelimit.limits["/dossier"]!.max; i++) {
      assert.equal(ratelimit.check("/dossier", peer).limited, false);
    }
    const retry = await app.request(path, {
      headers: {
        "x-forwarded-for": peer,
        "payment-signature": sig,
      },
    });
    assert.equal(retry.status, 200);
    assert.equal(await retry.text(), delivered);
    assert.equal(
      fac.ops().length,
      operations,
      "the exempt retry reconciles locally without a second verify or settle",
    );
  });

  test("buyer-only requirement extras cannot split one authorization into a second settlement", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const owner = archive.byTransaction(fac.tx);
    assert.ok(owner);
    const count = archivedCount();
    const before = fac.ops().length;

    const replayPayload = b64.decode(sig);
    replayPayload.accepted.extra = {
      ...(replayPayload.accepted.extra ?? {}),
      buyerOnly: { arbitrary: true },
    };
    replayPayload.resource = {
      url: "https://buyer.example/inert-transport",
      description: "not part of the signed authorization",
    };
    replayPayload.unknownTransportField = "ignored";
    const replayed = await paidRequest(
      `/dossier?tokenAddress=${ADDR.cake}`,
      b64.encode(replayPayload),
    );

    assert.equal(replayed.status, 200);
    assert.equal(await replayed.text(), firstBody);
    assert.equal(archive.byTransaction(fac.tx)?.id, owner!.id);
    assert.equal(archivedCount(), count, "no second archive candidate is created");
    assert.equal(
      fac.ops().length,
      before,
      "the semantic replay is resolved before facilitator verify or settle",
    );
  });

  test("a used-nonce facilitator rejection is bypassed by finalized replay state", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    const firstBody = await first.text();
    assert.equal(first.status, 200);

    fac.verifyValid = false;
    fac.verifyReason = "nonce_already_used";
    const before = fac.ops().length;
    const replayed = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(replayed.status, 200);
    assert.equal(await replayed.text(), firstBody);
    assert.equal(
      fac.ops().length,
      before,
      "the finalized fingerprint resolves before the used-nonce verification call",
    );
  });

  test("a used payment cannot buy a different report", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const firstRecord = archive.byTransaction(fac.tx);
    assert.ok(firstRecord);
    const count = archivedCount();

    const second = await paidRequest(
      `/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`,
      sig,
    );
    assert.equal(second.status, 409);
    const conflict = (await second.json()) as any;
    assert.equal(conflict.error, "payment_already_used");
    assert.equal(conflict.chargedAgain, false);
    assert.equal(archive.byTransaction(fac.tx)?.id, firstRecord!.id);
    assert.equal(archivedCount(), count, "the rejected report is not retained as an orphan");

    const recovered = await app.request("/dossier/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentTransaction: fac.tx }),
    });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as any).deliverable, firstBody);
  });

  test("distinct payment fingerprints that settle to one transaction adopt its original owner", async () => {
    const firstChallenge = await challenge(`/dossier?tokenAddress=${ADDR.cake}`);
    const firstSig = payment(firstChallenge.required);
    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, firstSig);
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const transaction = fac.tx;
    const owner = archive.byTransaction(transaction);
    assert.ok(owner);
    const ownerCount = archivedCount();

    // Generate a distinct nonce/fingerprint but force the facilitator to return
    // the already-owned transaction. This reaches the post-settle conflict
    // branch that an exact signature replay short-circuits before verification.
    fac.reset();
    const secondChallenge = await challenge(
      `/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`,
    );
    const secondSig = payment(secondChallenge.required);
    fac.tx = transaction;
    const second = await paidRequest(
      `/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`,
      secondSig,
    );
    assert.equal(second.status, 409);
    assert.equal((await second.json() as any).error, "payment_already_used");
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
    assert.equal(archive.byTransaction(transaction)?.id, owner!.id);
    assert.equal(archivedCount(), ownerCount, "the losing staged report is discarded");
    assert.equal(
      readdirSync(dir).some((name) => name.endsWith(".replay-hold")),
      false,
      "the losing replay hold is removed after owner adoption",
    );

    const beforeRetry = fac.ops().length;
    const retried = await paidRequest(
      `/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`,
      secondSig,
    );
    assert.equal(retried.status, 409);
    assert.equal((await retried.json() as any).error, "payment_already_used");
    assert.equal(
      fac.ops().length,
      beforeRetry,
      "the adopted fingerprint resolves without verifying or settling again",
    );

    const recovered = await app.request("/dossier/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentTransaction: transaction }),
    });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as any).deliverable, firstBody);
  });

  test("a retry adopts an existing transaction owner after conflict recovery", async () => {
    const firstChallenge = await challenge(`/dossier?tokenAddress=${ADDR.cake}`);
    const first = await paidRequest(
      `/dossier?tokenAddress=${ADDR.cake}`,
      payment(firstChallenge.required),
    );
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const owner = archive.byTransaction(fac.tx);
    assert.ok(owner?.settlement);
    const ownerTransaction = owner!.settlement!.transaction;
    const ownerCount = archivedCount();

    fac.reset();
    const secondChallenge = await challenge(
      `/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`,
    );
    const secondSig = payment(secondChallenge.required);
    const decodedSecond = b64.decode(secondSig);
    const secondRequirements = decodedSecond.accepted;
    const secondRequest = {
      paramsSha256: archive.paramsHash({
        tokenAddress: ADDR.uni,
        chain: "ethereum",
      }),
      contentType: "text/html" as const,
    };
    const fingerprint = paymentReplay.fingerprintPayment(
      decodedSecond,
      secondRequirements,
    );
    assert.ok(fingerprint);
    const begun = paymentReplay.begin(
      fingerprint!,
      secondRequest,
      secondRequirements,
    );
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;

    const candidateId = archive.newId();
    assert.equal(
      archive.save({
        id: candidateId,
        paramsSha256: secondRequest.paramsSha256,
        request: { tokenAddress: ADDR.uni, chain: "ethereum" },
        contentType: secondRequest.contentType,
        deliverable: "losing recovery candidate",
        deliveredAt: new Date().toISOString(),
      }),
      true,
    );
    assert.equal(
      paymentReplay.attachReport(fingerprint!, begun.attemptToken, candidateId),
      true,
    );
    assert.equal(
      paymentReplay.markUnknown(
        fingerprint!,
        begun.attemptToken,
        "archive_link_failed",
        {
          reportId: candidateId,
          settlement: {
            transaction: owner!.settlement!.transaction,
            network: owner!.settlement!.network,
            ...(owner!.settlement!.amount !== undefined
              ? { amount: owner!.settlement!.amount }
              : {}),
            ...(owner!.settlement!.payer !== undefined
              ? { payer: owner!.settlement!.payer }
              : {}),
          },
          settlementEvidence: "confirmed",
        },
      ),
      true,
    );

    const beforeRetry = fac.ops().length;
    const retried = await paidRequest(
      `/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`,
      secondSig,
    );
    assert.equal(retried.status, 409);
    assert.equal((await retried.json() as any).error, "payment_already_used");
    assert.equal(
      fac.ops().length,
      beforeRetry,
      "recovery adopts durable ownership before verify or settle",
    );
    assert.equal(archive.byTransaction(ownerTransaction)?.id, owner!.id);
    assert.equal(archive.byId(candidateId), null, "the losing candidate is discarded");
    assert.equal(archivedCount(), ownerCount);
    const repaired = paymentReplay.begin(
      fingerprint!,
      secondRequest,
      secondRequirements,
    );
    assert.equal(repaired.kind, "confirmed");
    if (repaired.kind === "confirmed") {
      assert.equal(repaired.state.reportId, owner!.id);
    }

    const sameRequest = await paidRequest(
      `/dossier?tokenAddress=${ADDR.cake}`,
      secondSig,
    );
    assert.equal(sameRequest.status, 200);
    assert.equal(await sameRequest.text(), firstBody);
    assert.equal(
      fac.ops().length,
      beforeRetry,
      "subsequent retries also resolve without facilitator calls",
    );
  });

  test("a conflict replay-adoption failure is moved to unknown", async () => {
    const firstChallenge = await challenge(`/dossier?tokenAddress=${ADDR.cake}`);
    const first = await paidRequest(
      `/dossier?tokenAddress=${ADDR.cake}`,
      payment(firstChallenge.required),
    );
    assert.equal(first.status, 200);
    const owner = archive.byTransaction(fac.tx);
    assert.ok(owner?.settlement);
    const ownerTransaction = owner!.settlement!.transaction;

    fac.reset();
    fac.tx = ownerTransaction;
    let mutatedReportId: string | undefined;
    const settlementC = {
      transaction: "0x" + "cc".repeat(32),
      network: NETWORK,
      payer: PAYER,
    };
    fac.beforeSettleResponse = () => {
      const pendingName = readdirSync(dir)
        .filter((name) => name.startsWith(".payment-") && name.endsWith(".state"))
        .find((name) => {
          try {
            return JSON.parse(readFileSync(`${dir}/${name}`, "utf8")).status === "pending";
          } catch {
            return false;
          }
        });
      assert.ok(pendingName);
      const statePath = `${dir}/${pendingName}`;
      const current = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(typeof current.reportId, "string");
      mutatedReportId = current.reportId;
      const {
        mac: _mac,
        ownerPid: _ownerPid,
        ownerStartedAt: _ownerStartedAt,
        ownerToken: _ownerToken,
        reason: _reason,
        settlement: _settlement,
        ...withoutVolatileFields
      } = current;
      const unknown = {
        ...withoutVolatileFields,
        status: "unknown",
        reason: "replay_commit_failed",
        settlement: settlementC,
        settlementEvidence: "confirmed",
        updatedAt: new Date().toISOString(),
      };
      const mac = createHmac("sha256", replayMacKey())
        .update(canonicalReplayValue(unknown))
        .digest("hex");
      writeFileSync(statePath, JSON.stringify({ ...unknown, mac }));
    };

    const secondChallenge = await challenge(`/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`);
    const secondSig = payment(secondChallenge.required);
    const retried = await paidRequest(
      `/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`,
      secondSig,
    );
    assert.equal(retried.status, 503);
    const body = (await retried.json()) as any;
    assert.equal(body.error, "payment_replay_unavailable");
    assert.equal(body.charged, "confirmed");
    assert.equal(body.paymentTransaction, ownerTransaction);
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
    assert.ok(mutatedReportId);

    const decodedSecond = b64.decode(secondSig);
    const fingerprint = paymentReplay.fingerprintPayment(decodedSecond, decodedSecond.accepted);
    assert.ok(fingerprint);
    const request = {
      paramsSha256: archive.paramsHash({ tokenAddress: ADDR.uni, chain: "ethereum" }),
      contentType: "text/html" as const,
    };
    const state = paymentReplay.begin(fingerprint!, request, decodedSecond.accepted);
    assert.equal(state.kind, "in_flight");
    if (state.kind === "in_flight") {
      assert.equal(state.state.status, "unknown");
      assert.equal(state.state.reason, "replay_commit_failed");
      assert.equal(state.state.reportId, mutatedReportId);
      assert.equal(state.state.settlement?.transaction, ownerTransaction);
    }
    assert.ok(archive.byId(mutatedReportId!));
    assert.equal(
      archive.byId(mutatedReportId!)?.settlement,
      undefined,
      "the losing staged candidate remains unclaimed for reconciliation",
    );
  });

  test("a process restart repairs replay state from durable settlement ownership", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    const firstBody = await first.text();
    const owner = archive.byTransaction(fac.tx);
    assert.ok(owner?.settlement);

    const stateName = replayStateForReport(owner!.id);
    assert.ok(stateName);
    const statePath = `${dir}/${stateName}`;
    const confirmed = JSON.parse(readFileSync(statePath, "utf8"));
    const { mac: _mac, settlement: _settlement, reason: _reason, ...pending } = confirmed;
    const crashed = {
      ...pending,
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    const mac = createHmac("sha256", replayMacKey())
      .update(canonicalReplayValue(crashed))
      .digest("hex");
    restoreReplayHold(confirmed);
    writeFileSync(statePath, JSON.stringify({ ...crashed, mac }));

    const before = fac.ops().length;
    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 200);
    assert.equal(await retried.text(), firstBody);
    assert.equal(
      fac.ops().length,
      before,
      "durable ownership repairs replay before verify or settle is attempted again",
    );
  });

  test("a confirmed replay receipt repairs a transient archive-link failure", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    const firstBody = await first.text();
    const owner = archive.byTransaction(fac.tx);
    assert.ok(owner?.settlement);

    const stateName = replayStateForReport(owner!.id);
    assert.ok(stateName);
    const statePath = `${dir}/${stateName}`;
    const confirmed = JSON.parse(readFileSync(statePath, "utf8"));
    const {
      mac: _mac,
      ownerPid: _ownerPid,
      ownerStartedAt: _ownerStartedAt,
      ownerToken: _ownerToken,
      ...withoutMac
    } = confirmed;
    const unknown = {
      ...withoutMac,
      status: "unknown",
      reason: "archive_link_failed",
      settlementEvidence: "confirmed",
      updatedAt: new Date().toISOString(),
    };
    const mac = createHmac("sha256", replayMacKey())
      .update(canonicalReplayValue(unknown))
      .digest("hex");
    restoreReplayHold(confirmed);
    writeFileSync(statePath, JSON.stringify({ ...unknown, mac }));

    const claimName = `.tx-${createHash("sha256")
      .update(fac.tx.toLowerCase())
      .digest("hex")}.claim`;
    unlinkSync(`${dir}/${claimName}`);
    const staged = JSON.parse(readFileSync(`${dir}/${owner!.id}.json`, "utf8"));
    delete staged.paymentTransaction;
    delete staged.settlement;
    delete staged.mac;
    staged.mac = archiveRecordMac(staged, process.env.ARCHIVE_MAC_KEY)!;
    writeFileSync(`${dir}/${owner!.id}.json`, JSON.stringify(staged));
    archive.resetIndex();

    const before = fac.ops().length;
    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 200);
    assert.equal(await retried.text(), firstBody);
    assert.equal(fac.ops().length, before, "repair occurs before verify or settle");
    assert.deepEqual(archive.byTransaction(fac.tx)?.settlement, owner!.settlement);
  });

  test("an unknown replay never adopts a different durable settlement", async () => {
    const path = `/dossier?tokenAddress=${ADDR.cake}`;
    const { required } = await challenge(path);
    const sig = payment(required);
    const decoded = b64.decode(sig);
    const requirements = decoded.accepted;
    const fingerprint = paymentReplay.fingerprintPayment(decoded, requirements);
    assert.ok(fingerprint);
    const request = {
      paramsSha256: archive.paramsHash({ tokenAddress: ADDR.cake }),
      contentType: "text/html" as const,
    };
    const begun = paymentReplay.begin(fingerprint!, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;

    const candidateId = archive.newId();
    assert.equal(
      archive.save({
        id: candidateId,
        paramsSha256: request.paramsSha256,
        request: { tokenAddress: ADDR.cake },
        contentType: request.contentType,
        deliverable: "candidate retained while settlements disagree",
        deliveredAt: new Date().toISOString(),
      }),
      true,
    );
    assert.equal(
      paymentReplay.attachReport(fingerprint!, begun.attemptToken, candidateId),
      true,
    );
    const settlementA = {
      transaction: "0x" + "aa".repeat(32),
      network: NETWORK,
      payer: PAYER,
    };
    const settlementB = {
      status: "confirmed" as const,
      transaction: "0x" + "bb".repeat(32),
      network: NETWORK,
      payer: PAYER,
    };
    assert.equal(
      paymentReplay.markUnknown(
        fingerprint!,
        begun.attemptToken,
        "archive_link_failed",
        {
          reportId: candidateId,
          settlement: settlementA,
          settlementEvidence: "confirmed",
        },
      ),
      true,
    );
    assert.equal(archive.linkConfirmedSettlement(candidateId, settlementB).kind, "linked");

    const before = fac.ops().length;
    const retried = await paidRequest(path, sig);
    assert.equal(retried.status, 503);
    assert.equal((await retried.json() as any).error, "payment_reconciliation_pending");
    assert.equal(
      fac.ops().length,
      before,
      "a settlement-identity mismatch is refused before verify or settle",
    );
    const replayed = paymentReplay.begin(fingerprint!, request, requirements);
    assert.equal(replayed.kind, "in_flight");
    if (replayed.kind === "in_flight") {
      assert.equal(replayed.state.status, "unknown");
      assert.deepEqual(replayed.state.settlement, settlementA);
      assert.equal(replayed.state.reportId, candidateId);
    }
    assert.deepEqual(archive.byId(candidateId)?.settlement, settlementB);
    assert.equal(
      archive.byId(candidateId)?.deliverable,
      "candidate retained while settlements disagree",
    );
  });
});

describe("the ways a buyer's client actually calls", () => {
  // Not hypothetical. This service already shipped a bug in this exact class:
  // paid callers whose client replayed with GET and a query string were
  // answered 400 and got no report, because only a POST body was read. Every
  // other paid test in this file replays the way our own tooling does, which is
  // the way least likely to find the next one.

  test("a paid POST carrying the parameters in a JSON body", async () => {
    // What the README's own curl example does, and what most buyers send.
    const unpaid = await app.request("/dossier", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenAddress: ADDR.cake }),
    });
    assert.equal(unpaid.status, 402);
    const required = b64.decode(unpaid.headers.get("payment-required")!);

    const r = await app.request("/dossier", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": payment(required),
      },
      body: JSON.stringify({ tokenAddress: ADDR.cake }),
    });
    assert.equal(r.status, 200, "a paid POST with a body must be served");
    assert.ok((await r.text()).includes("<html"));
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
    assert.equal(
      b64.decode(r.headers.get("payment-response")!).transaction,
      fac.tx,
      "and settles like any other paid call",
    );
  });

  test("a client that sends x-payment instead of payment-signature", async () => {
    // The SDK accepts either name. Ours had only ever been called with one, so
    // the other was a supported path with nothing holding it.
    const { required } = await challenge();
    const r = await app.request(`/dossier?tokenAddress=${ADDR.cake}`, {
      headers: { "x-payment": payment(required) },
    });
    assert.equal(r.status, 200, "the header alias is not a second-class caller");
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
  });

  test("the alias never displaces a real payment-signature", async () => {
    // Precedence has to be one-directional and boring. If the alias could
    // overwrite the header the OKX protocol actually specifies, adding a junk
    // `x-payment` to an otherwise good request would break it.
    const { required } = await challenge();
    const r = await app.request(`/dossier?tokenAddress=${ADDR.cake}`, {
      headers: {
        "payment-signature": payment(required),
        "x-payment": "not-a-payment-at-all",
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
  });

  test("an unreadable alias is just an unpaid call", async () => {
    const r = await app.request(`/dossier?tokenAddress=${ADDR.cake}`, {
      headers: { "x-payment": "}}}not base64 or json{{{" },
    });
    assert.equal(r.status, 402, "garbage under either name is not a payment");
    assert.deepEqual(fac.ops(), [], "and is never sent to the facilitator");
  });

  test("a paid POST whose body and query disagree: the body wins", async () => {
    // Both are read, and a client that carries the parameters twice must not
    // get a report on a token it did not name in the body it signed for.
    const { required } = await challenge();
    const r = await app.request(`/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": payment(required),
      },
      body: JSON.stringify({ tokenAddress: ADDR.cake, chain: "bsc" }),
    });
    assert.equal(r.status, 200);
    const html = (await r.text()).toLowerCase();
    assert.ok(html.includes(ADDR.cake), "the body's token is the one reported on");
    assert.equal(html.includes(ADDR.uni), false, "and the query's is not");
  });
});

describe("what must never be charged", () => {
  test("a payment the facilitator rejects gets no report", async () => {
    const { required } = await challenge();
    const before = archivedCount();
    fac.verifyValid = false;

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.equal(r.status, 402);
    assert.deepEqual(fac.ops(), ["verify"], "a rejected payment never reaches settle");
    assert.equal(archivedCount(), before, "and never runs the engine");

    // The other half of the outage work below: a facilitator that answered
    // "no" must keep looking like a refusal. If an outage and a refusal both
    // returned 503, the honesty fix would have destroyed the signal it exists
    // to protect.
    assert.notEqual(r.status, 503, "a real refusal is not an outage");
  });

  test("a non-2xx response never settles", async () => {
    const { required } = await challenge();
    // A verified payment for a token that does not exist. The handler answers
    // 404, and the buyer must not be charged for it: this is the invariant the
    // whole service is built on.
    const r = await paidRequest(
      `/dossier?tokenAddress=${ADDR.nowhere}&chain=bsc`,
      payment(required),
    );
    assert.ok(r.status >= 400, `expected an error status, got ${r.status}`);
    const body = (await r.json()) as any;
    assert.equal(body.charged, false);
    assert.deepEqual(fac.ops(), ["verify"], "settle must not be called on a non-2xx");
    assert.equal(r.headers.get("payment-response"), null, "and there is no receipt");
  });

  test("a paid HEAD is refused rather than charged for an empty body", async () => {
    const { required } = await challenge();
    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required), {
      method: "HEAD",
    });
    assert.equal(r.status, 405);
    assert.deepEqual(fac.ops(), ["verify"], "HEAD must never settle");
  });

  test("an invalid request is refused without settling", async () => {
    const { required } = await challenge();
    const r = await paidRequest("/dossier?tokenAddress=not-an-address", payment(required));
    assert.equal(r.status, 400);
    assert.deepEqual(fac.ops(), ["verify"]);
  });
});

describe("settlement failing after the report was generated", () => {
  test("the buyer is not handed the report, and no receipt is invented", async () => {
    const { required } = await challenge();
    const before = archivedCount();
    fac.settleOk = false;

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));

    // The SDK replaces the response once settlement fails, so the document the
    // handler built does not reach the buyer.
    assert.ok(r.status >= 400, `expected an error status, got ${r.status}`);
    const text = await r.text();
    assert.equal(text.includes("<html"), false, "a failed settlement returns no document");
    assert.deepEqual(fac.ops(), ["verify", "settle"]);

    // A definite facilitator refusal is not an unknown on-chain outcome. The
    // staged candidate is discarded so it cannot accumulate as an orphan or
    // later be mistaken for a paid recovery record.
    assert.equal(archivedCount(), before, "a definite settlement failure discards the staged report");
    const orphan = await app.request("/dossier/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentTransaction: fac.tx }),
    });
    assert.equal(orphan.status, 404, "an unsettled report is not recoverable by transaction");
  });

  test("a failed receipt carrying a transaction hash is not linked or recoverable", async () => {
    const { required } = await challenge();
    fac.settleOk = false;
    fac.settleFailureWithTx = true;

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.ok(r.status >= 400, `expected an error status, got ${r.status}`);
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
    assert.equal(
      archive.byTransaction(fac.tx),
      null,
      "a failed settlement hash must never become a recovery proof",
    );
  });

  test("a pending receipt is not treated as a confirmed recovery proof", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const decoded = b64.decode(sig);
    const fingerprint = paymentReplay.fingerprintPayment(decoded, decoded.accepted);
    assert.ok(fingerprint);
    fac.settleStatus = "pending";
    const before = archivedCount();

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(r.status, 503, "a pending settlement cannot deliver an unrecoverable report");
    assert.equal((await r.json() as any).error, "settlement_unconfirmed");
    assert.equal(
      archive.byTransaction(fac.tx),
      null,
      "pending settlement must not be indexed as confirmed",
    );
    assert.equal(
      archivedCount(),
      before + 1,
      "the staged artefact is retained for reconciliation while outcome is unknown",
    );
    const replay = JSON.parse(
      readFileSync(`${dir}/.payment-${fingerprint}.state`, "utf8"),
    );
    assert.equal(replay.status, "unknown");
    assert.equal(replay.reason, "receipt_unconfirmed");
    assert.deepEqual(replay.settlement, {
      transaction: fac.tx,
      network: NETWORK,
      amount: decoded.accepted.amount,
      payer: PAYER,
    });
    assert.equal(replay.settlementEvidence, "candidate");
  });

  test("an exact retry delivers after a pending settlement later confirms", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    fac.settleStatus = "pending";

    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 503);
    assert.equal(archive.byTransaction(fac.tx), null);
    const operationsBeforeRetry = fac.ops().length;
    const statusCallsBeforeRetry = fac.settleStatusCalls;

    fac.settleStatusResult = "success";
    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 200);
    assert.ok((await retried.text()).includes("<html"));
    assert.equal(
      fac.ops().length,
      operationsBeforeRetry,
      "pending reconciliation does not verify or settle the authorization twice",
    );
    assert.equal(fac.settleStatusCalls, statusCallsBeforeRetry + 1);
    assert.equal(archive.byTransaction(fac.tx)?.settlement?.status, "confirmed");
  });

  test("a pending settlement can reconcile when final status omits optional payer", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    fac.settleStatus = "pending";

    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 503);
    const operationsBeforeRetry = fac.ops().length;
    fac.settleStatusResult = "success";
    fac.settleStatusOmitPayer = true;

    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 200);
    assert.equal(fac.ops().length, operationsBeforeRetry);
    assert.equal(archive.byTransaction(fac.tx)?.settlement?.payer, PAYER);
  });

  test("a still-pending exact retry remains unresolved without a claim", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    fac.settleStatus = "pending";

    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 503);
    const operationsBeforeRetry = fac.ops().length;
    const statusCallsBeforeRetry = fac.settleStatusCalls;
    const claimsBeforeRetry = readdirSync(dir).filter(
      (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
    ).length;

    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 503);
    assert.equal((await retried.json() as any).error, "payment_reconciliation_pending");
    assert.equal(fac.ops().length, operationsBeforeRetry);
    assert.equal(fac.settleStatusCalls, statusCallsBeforeRetry + 1);
    assert.equal(archive.byTransaction(fac.tx), null);
    assert.equal(
      readdirSync(dir).filter(
        (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
      ).length,
      claimsBeforeRetry,
    );
  });

  test("a mismatched pending status result remains unresolved without a claim", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    fac.settleStatus = "pending";

    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 503);
    const operationsBeforeRetry = fac.ops().length;
    const statusCallsBeforeRetry = fac.settleStatusCalls;
    const claimsBeforeRetry = readdirSync(dir).filter(
      (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
    ).length;
    fac.settleStatusResult = "success";
    fac.settleStatusTransaction = "0x" + "66".repeat(32);

    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 503);
    assert.equal((await retried.json() as any).error, "payment_reconciliation_pending");
    assert.equal(fac.ops().length, operationsBeforeRetry);
    assert.equal(fac.settleStatusCalls, statusCallsBeforeRetry + 1);
    assert.equal(archive.byTransaction(fac.tx), null);
    assert.equal(
      readdirSync(dir).filter(
        (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
      ).length,
      claimsBeforeRetry,
    );
  });

  test("a failed pending status result remains unresolved without a claim", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    fac.settleStatus = "pending";

    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 503);
    const operationsBeforeRetry = fac.ops().length;
    const claimsBeforeRetry = readdirSync(dir).filter(
      (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
    ).length;
    fac.settleStatusResult = "failed";

    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 503);
    assert.equal((await retried.json() as any).error, "payment_reconciliation_pending");
    assert.equal(fac.ops().length, operationsBeforeRetry);
    assert.equal(archive.byTransaction(fac.tx), null);
    assert.equal(
      readdirSync(dir).filter(
        (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
      ).length,
      claimsBeforeRetry,
    );
  });

  test("a pending status-query outage remains unresolved without a claim", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    fac.settleStatus = "pending";

    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 503);
    const operationsBeforeRetry = fac.ops().length;
    const statusCallsBeforeRetry = fac.settleStatusCalls;
    const claimsBeforeRetry = readdirSync(dir).filter(
      (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
    ).length;
    fac.settleStatusDown = true;

    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 503);
    assert.equal((await retried.json() as any).error, "payment_reconciliation_pending");
    assert.equal(fac.ops().length, operationsBeforeRetry);
    assert.equal(fac.settleStatusCalls, statusCallsBeforeRetry + 1);
    assert.equal(archive.byTransaction(fac.tx), null);
    assert.equal(
      readdirSync(dir).filter(
        (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
      ).length,
      claimsBeforeRetry,
    );
  });

  test("a successful-looking receipt for another network is not linked", async () => {
    const { required } = await challenge();
    fac.settleNetwork = "eip155:1";

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.equal(r.status, 503);
    assert.equal(
      archive.byTransaction(fac.tx),
      null,
      "a receipt must match the network in the server's payment requirement",
    );
  });

  test("a receipt that claims the wrong settled amount is not linked", async () => {
    const { required } = await challenge();
    fac.settleAmount = "1";

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.equal(r.status, 503);
    assert.equal(
      archive.byTransaction(fac.tx),
      null,
      "the receipt amount must match the requirement passed to settlement",
    );
  });

  test("a timeout that the SDK later confirms is linked and recoverable", async () => {
    const { required } = await challenge();
    fac.settleOk = false;
    fac.settleFailureWithTx = true;
    fac.settleStatus = "timeout";
    fac.settleStatusResult = "success";

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.equal(r.status, 200);
    const receipt = b64.decode(r.headers.get("payment-response")!);
    assert.equal(receipt.success, true, "the buyer receives the normalized final receipt");
    assert.equal(receipt.status, "success");
    assert.equal(archive.byTransaction(fac.tx)?.settlement?.status, "confirmed");
  });

  test("a timeout poll for another transaction is retained as unknown", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const decoded = b64.decode(sig);
    const fingerprint = paymentReplay.fingerprintPayment(decoded, decoded.accepted);
    assert.ok(fingerprint);
    fac.settleOk = false;
    fac.settleFailureWithTx = true;
    fac.settleStatus = "timeout";
    fac.settleStatusResult = "success";
    fac.settleStatusTransaction = "0x" + "77".repeat(32);

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("payment-response"), null);
    assert.equal(archive.byTransaction(fac.tx), null);
    const replay = JSON.parse(
      readFileSync(`${dir}/.payment-${fingerprint}.state`, "utf8"),
    );
    assert.equal(replay.status, "unknown");
    assert.equal(replay.reason, "settlement_timeout");
    assert.deepEqual(replay.settlement, {
      transaction: fac.tx,
      network: NETWORK,
      amount: decoded.accepted.amount,
      payer: PAYER,
    });
    assert.equal(replay.settlementEvidence, "candidate");

    const claimsBeforeRetry = readdirSync(dir).filter(
      (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
    ).length;
    const operationsBeforeRetry = fac.ops().length;
    const statusCallsBeforeRetry = fac.settleStatusCalls;
    const peer = "198.51.100.91";
    for (let i = 0; i < ratelimit.limits["/dossier"]!.max; i++) {
      assert.equal(ratelimit.check("/dossier", peer).limited, false);
    }
    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig, {
      headers: { "x-forwarded-for": peer },
    });
    assert.equal(retried.status, 503);
    assert.equal((await retried.json() as any).error, "payment_reconciliation_pending");
    assert.equal(
      fac.ops().length,
      operationsBeforeRetry,
      "a contradictory timeout status never re-verifies or re-settles",
    );
    assert.equal(fac.settleStatusCalls, statusCallsBeforeRetry + 1);
    assert.equal(archive.byTransaction(fac.tx), null);
    assert.equal(
      readdirSync(dir).filter(
        (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
      ).length,
      claimsBeforeRetry,
      "candidate timeout evidence cannot create a transaction claim",
    );
  });

  test("a timeout status-query outage is retained as unknown rather than a fresh 402", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const decoded = b64.decode(sig);
    const fingerprint = paymentReplay.fingerprintPayment(decoded, decoded.accepted);
    assert.ok(fingerprint);
    fac.settleOk = false;
    fac.settleFailureWithTx = true;
    fac.settleStatus = "timeout";
    fac.settleStatusDown = true;

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(r.status, 503);
    const body = (await r.json()) as any;
    assert.equal(body.error, "payment_reconciliation_pending");
    assert.ok(body.reconciliationId);
    assert.equal(r.headers.get("payment-response"), null);
    const replay = JSON.parse(
      readFileSync(`${dir}/.payment-${fingerprint}.state`, "utf8"),
    );
    assert.equal(replay.status, "unknown");
    assert.equal(replay.reason, "settlement_timeout");
    assert.deepEqual(replay.settlement, {
      transaction: fac.tx,
      network: NETWORK,
      amount: decoded.accepted.amount,
      payer: PAYER,
    });
    assert.equal(replay.settlementEvidence, "candidate");

    const claimsBeforeRetry = readdirSync(dir).filter(
      (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
    ).length;
    const operationsBeforeRetry = fac.ops().length;
    const statusCallsBeforeRetry = fac.settleStatusCalls;
    const peer = "198.51.100.92";
    for (let i = 0; i < ratelimit.limits["/dossier"]!.max; i++) {
      assert.equal(ratelimit.check("/dossier", peer).limited, false);
    }
    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig, {
      headers: { "x-forwarded-for": peer },
    });
    assert.equal(retried.status, 503);
    assert.equal((await retried.json() as any).error, "payment_reconciliation_pending");
    assert.equal(
      fac.ops().length,
      operationsBeforeRetry,
      "a status-query outage aborts before verify or settle",
    );
    assert.equal(fac.settleStatusCalls, statusCallsBeforeRetry + 1);
    assert.equal(archive.byTransaction(fac.tx), null);
    assert.equal(
      readdirSync(dir).filter(
        (name) => name.startsWith(".tx-") && name.endsWith(".claim"),
      ).length,
      claimsBeforeRetry,
      "an unavailable status query cannot promote timeout evidence",
    );
  });

  test("an exact retry delivers only after a fresh matching timeout status succeeds", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const decoded = b64.decode(sig);
    const fingerprint = paymentReplay.fingerprintPayment(decoded, decoded.accepted);
    assert.ok(fingerprint);
    fac.settleOk = false;
    fac.settleFailureWithTx = true;
    fac.settleStatus = "timeout";
    fac.settleStatusResult = "success";
    fac.settleStatusTransaction = "0x" + "88".repeat(32);

    const first = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(first.status, 503);
    assert.equal(archive.byTransaction(fac.tx), null);
    const before = fac.ops().length;
    const statusBefore = fac.settleStatusCalls;

    fac.settleStatusTransaction = undefined;
    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 200);
    assert.ok((await retried.text()).includes("<html"));
    assert.equal(
      fac.ops().length,
      before,
      "reconciliation queries status but does not verify or settle twice",
    );
    assert.equal(fac.settleStatusCalls, statusBefore + 1);
    assert.equal(archive.byTransaction(fac.tx)?.settlement?.status, "confirmed");
    const replay = paymentReplay.begin(
      fingerprint!,
      {
        paramsSha256: archive.paramsHash({ tokenAddress: ADDR.cake }),
        contentType: "text/html",
      },
      decoded.accepted,
    );
    assert.equal(replay.kind, "confirmed");
  });
});

describe("a facilitator that gives no answer", () => {
  // The distinction this whole block exists for: "your payment is invalid" and
  // "we could not check your payment" are different sentences, and the SDK says
  // the first for both. Everywhere else this service refuses to report an
  // unknown as a known — sources are tri-state, an unreadable state file stops
  // the watcher rather than letting it forget — and the payment layer was the
  // one place that did not.

  test("an unreachable verify is an outage, not a refusal", async () => {
    const { required } = await challenge();
    fac.down = true;

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));

    assert.equal(r.status, 503, "not 402: the buyer's payment was never judged");
    assert.equal(r.headers.get("retry-after"), "60");
    const body = (await r.json()) as any;
    assert.equal(body.error, "payment_layer_unreachable");
    assert.equal(body.charged, false, "and nothing was taken");
    assert.match(body.message, /not a refusal/);
    assert.equal(
      fac.ops().includes("settle"),
      false,
      "nothing settles while the facilitator is unreachable",
    );
    // Hono copies every header from the response being replaced onto its
    // replacement, so this would arrive carrying the 402's challenge and go on
    // telling the buyer payment is required in the one place machines read.
    assert.equal(
      r.headers.get("payment-required"),
      null,
      "and no challenge rides along on it",
    );

    // The free pages have nothing to do with the facilitator, and an outage
    // that took them down once took the whole site with it.
    assert.equal((await app.request("/")).status, 200);
    assert.equal((await app.request("/health")).status, 200);
    assert.equal((await app.request("/dossier/sample")).status, 200);
  });

  test("two cold-start failures release their replay attempts before a clean retry", async () => {
    const { required } = await challenge();
    const sig = payment(required);
    const decoded = b64.decode(sig);
    const fingerprint = paymentReplay.fingerprintPayment(decoded, decoded.accepted);
    assert.ok(fingerprint);
    failBeforeHandler = 2;

    const failed = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json() as any).error, "payment layer temporarily unavailable — no payment was taken, retry shortly");
    assert.deepEqual(fac.ops(), ["verify", "verify"]);
    assert.equal(
      existsSync(`${dir}/.payment-${fingerprint}.state`),
      false,
      "the second cold-start catch releases the request-owned replay state",
    );

    const retried = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, sig);
    assert.equal(retried.status, 200);
    assert.deepEqual(
      fac.ops(),
      ["verify", "verify", "verify", "settle"],
      "the same signed payment can verify and settle after the transient failures",
    );
  });

  test("an unreachable settle says the outcome is unknown, not that payment is due", async () => {
    const { required } = await challenge();
    fac.settleDown = true;

    const r = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));

    // The expensive case. The payment was verified and our instruction to move
    // the money went into silence, so it may well have settled. The SDK's answer
    // is a bare 402, which invites an obliging client to sign a second payment.
    assert.equal(r.status, 503, "not 402: we do not know that payment is required");
    const body = (await r.json()) as any;
    assert.equal(body.error, "settlement_unconfirmed");
    assert.equal(body.charged, "unknown", "because it genuinely is");
    assert.match(body.message, /cannot be settled twice/, "the retry has to be safe to make");
    assert.equal(body.message.includes("<html"), false, "and it is not the report");
    assert.deepEqual(fac.ops(), ["verify", "settle"]);
    // The SDK builds a receipt for the failed attempt, reporting a definite
    // failure with an empty transaction. It contradicts every word above, so it
    // must not survive onto this response.
    assert.equal(r.headers.get("payment-response"), null, "no receipt is invented");
  });

  test("a facilitator that answers keeps its answer", async () => {
    // The guard on the guard. If an outage and a refusal both became 503, this
    // work would have destroyed the signal it exists to protect. Both real
    // answers must survive it: a refused payment stays 402, and a settlement
    // that genuinely failed on chain stays a settlement failure.
    const { required } = await challenge();
    fac.verifyValid = false;
    const refused = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.equal(refused.status, 402, "a refusal the facilitator made is still a refusal");

    fac.reset();
    fac.settleOk = false;
    const failed = await paidRequest(`/dossier?tokenAddress=${ADDR.cake}`, payment(required));
    assert.equal(failed.status, 402, "and an on-chain failure is not an outage");
    const text = await failed.text();
    assert.equal(
      text.includes("settlement_unconfirmed"),
      false,
      "a definite failure must not be reported as an unknown one",
    );
  });
});

describe("the internal fulfilment bypass", () => {
  test("serves a task buyer without touching the payment layer", async () => {
    const r = await app.request(`/dossier?tokenAddress=${ADDR.cake}`, {
      headers: {
        "x-internal-key": process.env.INTERNAL_KEY!,
        "x-job-id": "0x" + "cd".repeat(32),
      },
    });
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes("<html"));
    assert.deepEqual(
      fac.ops(),
      [],
      "a task buyer paid at the task level and must never be quoted an x402 challenge",
    );
    assert.ok(r.headers.get("x-recovery-code"), "and is given a recovery code");
  });

  test("a wrong internal key is just an unpaid caller", async () => {
    const r = await app.request(`/dossier?tokenAddress=${ADDR.cake}`, {
      headers: { "x-internal-key": "not-the-key" },
    });
    assert.equal(r.status, 402);
  });
});
