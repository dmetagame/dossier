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
import { readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { stubUpstream, tempArchive, ADDR } from "./helpers";

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
  /**
   * Make a call unreachable, as an outage, a revoked key or a 500 would. This
   * is not the same as the facilitator answering "no", and the service must not
   * treat it as though it were.
   */
  down: false,
  settleDown: false,
  /** Archive size observed at the moment settle was called. */
  archivedAtSettle: -1,
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
    this.down = false;
    this.settleDown = false;
    this.archivedAtSettle = -1;
    this.tx = "0x" + randomBytes(32).toString("hex");
  },
  ops(): Op[] {
    return this.calls.map((c) => c.op);
  },
};

const archivedCount = () => readdirSync(dir).length;

const json = (data: unknown) =>
  new Response(JSON.stringify({ code: "0", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

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

  if (url.endsWith("/settle")) {
    fac.calls.push({ op: "settle", body });
    if (fac.settleDown) throw new Error("simulated facilitator outage during settle");
    // Read at the moment money would move. The handler archives before it
    // responds, so a report that exists here is one the buyer is about to get.
    fac.archivedAtSettle = archivedCount();
    return json(
      fac.settleOk
        ? { success: true, status: "success", transaction: fac.tx, network: NETWORK, payer: PAYER }
        : {
            success: false,
            errorReason: fac.settleReason,
            errorMessage: "settlement failed on chain",
            transaction: "",
            network: NETWORK,
            payer: PAYER,
          },
    );
  }

  throw new Error(`unstubbed facilitator call: ${url}`);
}) as typeof fetch;

const { app, paymentLayerState } = await import("../src/app");
const archive = await import("../src/dossier/archive");

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
        nonce: "0x" + "22".repeat(32),
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
  restore();
  globalThis.fetch = upstream;
  cleanup();
});
beforeEach(() => {
  fac.reset();
  archive.resetIndex();
});

describe("the payment challenge", () => {
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

    // The report was still built and archived before settlement was attempted.
    // That is not a leak — nothing was served — but it is a record with no
    // transaction on it, and it must stay unreachable rather than become a
    // free report for whoever guesses at it.
    assert.equal(archivedCount(), before + 1, "the report is archived either way");
    const orphan = await app.request("/dossier/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentTransaction: fac.tx }),
    });
    assert.equal(orphan.status, 404, "an unsettled report is not recoverable by transaction");
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
