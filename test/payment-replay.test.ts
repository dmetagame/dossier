import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { tempArchive } from "./helpers";
import * as archive from "../src/dossier/archive";
import * as replay from "../src/payment-replay";

const temp = tempArchive();
const control = tempArchive();
const workerPath = fileURLToPath(new URL("./payment-replay-worker.ts", import.meta.url));
const repoDir = fileURLToPath(new URL("..", import.meta.url));
const activeChildren = new Set<ChildProcess>();
const previousDir = process.env.ARCHIVE_DIR;
const previousKey = process.env.PAYMENT_REPLAY_KEY;
const previousArchiveKey = process.env.ARCHIVE_MAC_KEY;
const previousArchiveRequired = process.env.ARCHIVE_MAC_REQUIRED;
process.env.ARCHIVE_DIR = temp.dir;
process.env.PAYMENT_REPLAY_KEY = "payment-replay-unit-test-key";
process.env.ARCHIVE_MAC_KEY = "payment-replay-archive-test-key";
process.env.ARCHIVE_MAC_REQUIRED = "1";

const request: replay.ReplayRequestIdentity = {
  paramsSha256: "a".repeat(64),
  contentType: "text/html",
};
const requirements: replay.ReplayRequirements & {
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
} = {
  scheme: "exact",
  network: "eip155:196",
  amount: "10000",
  asset: "0x0000000000000000000000000000000000000001",
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Tether", version: "1" },
};
const fingerprintRequirements = requirements;
const payload = {
  x402Version: 2,
  accepted: fingerprintRequirements,
  payload: {
    signature: "0x" + "11".repeat(65),
    authorization: {
      from: "0x0000000000000000000000000000000000000003",
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x" + "22".repeat(32),
    },
  },
};
const REPORT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPORT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function clean(): void {
  for (const dir of [temp.dir, control.dir]) {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* test cleanup is best effort */
      }
    }
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
    .join(",")}}`;
}

function remacState(path: string, mutate: (state: Record<string, unknown>) => void): void {
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(state);
  delete state.mac;
  const derived = createHash("sha256")
    .update(`dossier-payment-replay:${process.env.PAYMENT_REPLAY_KEY}`)
    .digest();
  state.mac = createHmac("sha256", derived).update(canonicalValue(state)).digest("hex");
  writeFileSync(path, JSON.stringify(state));
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(10);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function saveReport(id: string): void {
  assert.equal(
    archive.save({
      id,
      paramsSha256: request.paramsSha256,
      request: { tokenAddress: "0xabc" },
      contentType: request.contentType,
      deliverable: `report-${id}`,
      deliveredAt: new Date().toISOString(),
    }),
    true,
  );
}

beforeEach(clean);
afterEach(async () => {
  await Promise.all([...activeChildren].map(stopChild));
});
after(async () => {
  await Promise.all([...activeChildren].map(stopChild));
  temp.cleanup();
  control.cleanup();
  if (previousDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = previousDir;
  if (previousKey === undefined) delete process.env.PAYMENT_REPLAY_KEY;
  else process.env.PAYMENT_REPLAY_KEY = previousKey;
  if (previousArchiveKey === undefined) delete process.env.ARCHIVE_MAC_KEY;
  else process.env.ARCHIVE_MAC_KEY = previousArchiveKey;
  if (previousArchiveRequired === undefined) delete process.env.ARCHIVE_MAC_REQUIRED;
  else process.env.ARCHIVE_MAC_REQUIRED = previousArchiveRequired;
});

describe("durable payment replay state", () => {
  test("canonical EIP-3009 authorization semantics share one opaque fingerprint", () => {
    const first = replay.fingerprintPayment(payload, fingerprintRequirements);
    const second = replay.fingerprintPayment(
      {
        x402Version: 2,
        accepted: {
          ...fingerprintRequirements,
          extra: {
            ...fingerprintRequirements.extra,
            buyerOnly: { arbitrary: true },
          },
        },
        resource: { url: "https://buyer.example/anything" },
        extensions: { ignored: true },
        payload: {
          ignored: "transport-only",
          signature: String(payload.payload.signature).toUpperCase().replace("0X", "0x"),
          authorization: {
            ...payload.payload.authorization,
            from: String(payload.payload.authorization.from).toUpperCase().replace("0X", "0x"),
            to: String(payload.payload.authorization.to).toUpperCase().replace("0X", "0x"),
            value: "00010000",
            validAfter: "000",
            validBefore: "09999999999",
            nonce: String(payload.payload.authorization.nonce).toUpperCase().replace("0X", "0x"),
          },
        },
        unknown: "ignored",
      },
      {
        ...fingerprintRequirements,
        network: "eip155:0196",
        asset: fingerprintRequirements.asset.toUpperCase().replace("0X", "0x"),
        payTo: fingerprintRequirements.payTo.toUpperCase().replace("0X", "0x"),
        maxTimeoutSeconds: 999,
        extra: {
          ...fingerprintRequirements.extra,
          serverOnlyMetadata: "ignored",
        },
      },
    );
    assert.equal(first, second);
    assert.match(first!, /^[a-f0-9]{64}$/);
  });

  test("semantic EIP-3009 mutations produce different fingerprints", () => {
    const first = replay.fingerprintPayment(payload, fingerprintRequirements);
    const mutateAuthorization = (key: string, value: string) =>
      replay.fingerprintPayment(
        {
          ...payload,
          payload: {
            ...payload.payload,
            authorization: { ...payload.payload.authorization, [key]: value },
          },
        },
        fingerprintRequirements,
      );
    for (const [key, value] of [
      ["from", "0x0000000000000000000000000000000000000004"],
      ["to", "0x0000000000000000000000000000000000000005"],
      ["value", "10001"],
      ["validAfter", "1"],
      ["validBefore", "9999999998"],
      ["nonce", "0x" + "23".repeat(32)],
    ]) {
      assert.notEqual(mutateAuthorization(key, value), first, key);
    }
    assert.notEqual(
      replay.fingerprintPayment(payload, {
        ...fingerprintRequirements,
        extra: { ...fingerprintRequirements.extra, name: "Different Token" },
      }),
      first,
    );
    assert.notEqual(
      replay.fingerprintPayment(payload, {
        ...fingerprintRequirements,
        extra: { ...fingerprintRequirements.extra, version: "2" },
      }),
      first,
    );
    assert.notEqual(
      replay.fingerprintPayment(payload, {
        ...fingerprintRequirements,
        network: "eip155:197",
      }),
      first,
    );
    assert.notEqual(
      replay.fingerprintPayment(payload, {
        ...fingerprintRequirements,
        asset: "0x0000000000000000000000000000000000000006",
      }),
      first,
    );
  });

  test("Permit2 fingerprints normalize representations but preserve every signed field", () => {
    const permit2 = {
      x402Version: 2,
      accepted: { ...fingerprintRequirements, extra: { assetTransferMethod: "permit2" } },
      payload: {
        signature: "0x" + "ab".repeat(65),
        permit2Authorization: {
          from: "0x0000000000000000000000000000000000000010",
          permitted: { token: requirements.asset, amount: "10000" },
          spender: "0x0000000000000000000000000000000000000011",
          nonce: "42",
          deadline: "9999999999",
          witness: { to: requirements.payTo, validAfter: "0" },
        },
      },
    };
    const first = replay.fingerprintPayment(permit2, fingerprintRequirements);
    const equivalent = structuredClone(permit2) as any;
    equivalent.payload.signature = equivalent.payload.signature.toUpperCase().replace("0X", "0x");
    equivalent.payload.permit2Authorization.from = equivalent.payload.permit2Authorization.from.toUpperCase().replace("0X", "0x");
    equivalent.payload.permit2Authorization.permitted.token = equivalent.payload.permit2Authorization.permitted.token.toUpperCase().replace("0X", "0x");
    equivalent.payload.permit2Authorization.permitted.amount = "00010000";
    equivalent.payload.permit2Authorization.spender = equivalent.payload.permit2Authorization.spender.toUpperCase().replace("0X", "0x");
    equivalent.payload.permit2Authorization.nonce = "00042";
    equivalent.payload.permit2Authorization.deadline = "09999999999";
    equivalent.payload.permit2Authorization.witness.to = equivalent.payload.permit2Authorization.witness.to.toUpperCase().replace("0X", "0x");
    equivalent.payload.permit2Authorization.witness.validAfter = "000";
    equivalent.accepted.extra.buyerOnly = true;
    equivalent.resource = { url: "https://buyer.example/inert" };
    assert.equal(replay.fingerprintPayment(equivalent, fingerprintRequirements), first);
    assert.match(first!, /^[a-f0-9]{64}$/);

    for (const mutate of [
      (value: any) => { value.from = "0x0000000000000000000000000000000000000012"; },
      (value: any) => { value.permitted.token = "0x0000000000000000000000000000000000000013"; },
      (value: any) => { value.permitted.amount = "10001"; },
      (value: any) => { value.spender = "0x0000000000000000000000000000000000000014"; },
      (value: any) => { value.nonce = "43"; },
      (value: any) => { value.deadline = "9999999998"; },
      (value: any) => { value.witness.to = "0x0000000000000000000000000000000000000015"; },
      (value: any) => { value.witness.validAfter = "1"; },
    ]) {
      const changed = structuredClone(permit2) as any;
      mutate(changed.payload.permit2Authorization);
      assert.notEqual(replay.fingerprintPayment(changed, fingerprintRequirements), first);
    }
  });

  test("malformed and ambiguous authorization shapes fail closed", () => {
    assert.equal(
      replay.fingerprintPayment(
        {
          ...payload,
          payload: { ...payload.payload, permit2Authorization: {} },
        },
        fingerprintRequirements,
      ),
      null,
    );
    assert.equal(
      replay.fingerprintPayment(
        {
          ...payload,
          payload: {
            ...payload.payload,
            authorization: { ...payload.payload.authorization, value: "1" },
          },
        },
        fingerprintRequirements,
      ),
      null,
      "an authorization that does not satisfy the server amount is unavailable",
    );
    assert.equal(
      replay.fingerprintPayment(
        {
          ...payload,
          payload: {
            ...payload.payload,
            authorization: {
              ...payload.payload.authorization,
              to: "0x0000000000000000000000000000000000000009",
            },
          },
        },
        fingerprintRequirements,
      ),
      null,
      "an authorization for another recipient is unavailable",
    );
    assert.equal(
      replay.fingerprintPayment(
        { ...payload, x402Version: 1 },
        fingerprintRequirements,
      ),
      null,
    );
    assert.equal(
      replay.fingerprintPayment(
        { ...payload, payload: { ...payload.payload, signature: "" } },
        fingerprintRequirements,
      ),
      null,
    );
    assert.equal(
      replay.fingerprintPayment(
        {
          ...payload,
          payload: {
            ...payload.payload,
            authorization: { ...payload.payload.authorization, nonce: "0x01" },
          },
        },
        fingerprintRequirements,
      ),
      null,
    );
    assert.equal(
      replay.fingerprintPayment(
        {
          ...payload,
          payload: {
            ...payload.payload,
            authorization: { ...payload.payload.authorization, value: "-1" },
          },
        },
        fingerprintRequirements,
      ),
      null,
    );
  });

  test("signature bytes are proof, not replay identity", () => {
    const first = replay.fingerprintPayment(payload, fingerprintRequirements);
    const second = replay.fingerprintPayment(
      {
        ...payload,
        payload: { ...payload.payload, signature: "0x" + "ff".repeat(65) },
      },
      fingerprintRequirements,
    );
    assert.equal(first, second);
  });

  test("canonical decoded payload property order is irrelevant", () => {
    const first = replay.fingerprintPayment(payload, fingerprintRequirements);
    const second = replay.fingerprintPayment(
      {
        payload: payload.payload,
        accepted: fingerprintRequirements,
        x402Version: 2,
      },
      { ...fingerprintRequirements },
    );
    assert.equal(first, second);
    assert.match(first!, /^[a-f0-9]{64}$/);
  });

  test("creates pending state, attaches the report, and finalizes one owner", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, {
        transaction: "0x" + "33".repeat(32),
        network: "eip155:196",
        payer: "0x" + "44".repeat(20),
      }),
      true,
    );
    const retry = replay.begin(fingerprint, request, requirements);
    assert.equal(retry.kind, "confirmed");
    if (retry.kind === "confirmed") {
      assert.equal(retry.state.reportId, REPORT_A);
      assert.equal(retry.state.settlement?.transaction, "0x" + "33".repeat(32));
    }
  });

  test("same-process concurrent begin remains in flight", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const first = replay.begin(fingerprint, request, requirements);
    assert.equal(first.kind, "created");
    const second = replay.begin(fingerprint, request, requirements);
    assert.equal(second.kind, "in_flight");
    if (first.kind === "created" && second.kind === "in_flight") {
      assert.equal(second.state.attemptToken, first.attemptToken);
    }
  });

  test("read-only existing-state authentication never creates or changes replay files", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const before = readdirSync(temp.dir).sort();
    assert.equal(replay.existing(fingerprint).kind, "not_found");
    assert.deepEqual(readdirSync(temp.dir).sort(), before);

    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    const statePath = `${temp.dir}/.payment-${fingerprint}.state`;
    const durable = readFileSync(statePath, "utf8");
    const files = readdirSync(temp.dir).sort();

    const found = replay.existing(fingerprint);
    assert.equal(found.kind, "found");
    if (found.kind === "found") assert.equal(found.state.status, "pending");
    assert.equal(readFileSync(statePath, "utf8"), durable);
    assert.deepEqual(readdirSync(temp.dir).sort(), files);

    writeFileSync(statePath, "{}", { mode: 0o600 });
    assert.equal(replay.existing(fingerprint).kind, "corrupt");
    assert.equal(readFileSync(statePath, "utf8"), "{}");
  });

  test("a crashed process leaves an unattached state that the next process reclaims", async () => {
    const fingerprint = replay.fingerprintPayment(
      { ...payload, payload: { ...payload.payload, signature: "0x" + "12".repeat(65) } },
      requirements,
    )!;
    const readyPath = join(control.dir, "replay-worker-ready.json");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, fingerprint, readyPath],
      {
        cwd: repoDir,
        env: {
          ...process.env,
          ARCHIVE_DIR: temp.dir,
          PAYMENT_REPLAY_KEY: process.env.PAYMENT_REPLAY_KEY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    activeChildren.add(child);
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        activeChildren.delete(child);
        resolve();
      });
    });
    try {
      await waitForFile(readyPath);
      const created = JSON.parse(readFileSync(readyPath, "utf8"));
      assert.equal(created.kind, "created");
      assert.equal(replay.begin(fingerprint, request, requirements).kind, "in_flight");

      child.kill("SIGKILL");
      await exited;
      const recovered = replay.begin(fingerprint, request, requirements);
      assert.equal(recovered.kind, "created");
      if (recovered.kind === "created") {
        assert.notEqual(recovered.attemptToken, created.attemptToken);
      }
    } finally {
      await stopChild(child);
    }
  });

  test("a stale unattached state is reclaimed even when its PID is still alive", () => {
    const fingerprint = replay.fingerprintPayment(
      { ...payload, payload: { ...payload.payload, signature: "0x" + "13".repeat(65) } },
      requirements,
    )!;
    const first = replay.begin(fingerprint, request, requirements);
    assert.equal(first.kind, "created");
    const path = `${temp.dir}/.payment-${fingerprint}.state`;
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    remacState(path, (state) => {
      state.createdAt = stale;
      state.updatedAt = stale;
    });

    const recovered = replay.begin(fingerprint, request, requirements);
    assert.equal(recovered.kind, "created");
    if (first.kind === "created" && recovered.kind === "created") {
      assert.notEqual(recovered.attemptToken, first.attemptToken);
    }
  });

  test("legacy ownerless pending state stays in flight until it is stale", () => {
    const fingerprint = replay.fingerprintPayment(
      { ...payload, payload: { ...payload.payload, signature: "0x" + "15".repeat(65) } },
      requirements,
    )!;
    const first = replay.begin(fingerprint, request, requirements);
    assert.equal(first.kind, "created");
    const path = `${temp.dir}/.payment-${fingerprint}.state`;
    remacState(path, (state) => {
      delete state.ownerPid;
      delete state.ownerStartedAt;
      delete state.ownerToken;
    });
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "in_flight");

    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    remacState(path, (state) => {
      state.createdAt = stale;
      state.updatedAt = stale;
    });
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "created");
  });

  test("invalid and reversed replay timestamps fail closed as corrupt", () => {
    const fingerprint = replay.fingerprintPayment(
      { ...payload, payload: { ...payload.payload, signature: "0x" + "14".repeat(65) } },
      requirements,
    )!;
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "created");
    const path = `${temp.dir}/.payment-${fingerprint}.state`;
    remacState(path, (state) => {
      state.updatedAt = "not-a-timestamp";
    });
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "corrupt");

    clean();
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "created");
    remacState(path, (state) => {
      state.createdAt = "2026-08-12T00:01:00.000Z";
      state.updatedAt = "2026-08-12T00:00:00.000Z";
    });
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "corrupt");
  });

  test("MAC-valid non-string replay identifiers fail closed as corrupt", () => {
    const fingerprint = replay.fingerprintPayment(
      { ...payload, payload: { ...payload.payload, signature: "0x" + "16".repeat(65) } },
      requirements,
    )!;
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "created");
    const path = `${temp.dir}/.payment-${fingerprint}.state`;
    remacState(path, (state) => {
      state.attemptToken = [state.attemptToken];
    });
    assert.equal(replay.ready(), false);
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "corrupt");
  });

  test("MAC-valid whitespace-padded settlement hashes fail closed as corrupt", () => {
    const fingerprint = replay.fingerprintPayment(
      { ...payload, payload: { ...payload.payload, signature: "0x" + "17".repeat(65) } },
      requirements,
    )!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, {
        transaction: "0x" + "18".repeat(32),
        network: requirements.network,
      }),
      true,
    );
    const path = `${temp.dir}/.payment-${fingerprint}.state`;
    remacState(path, (state) => {
      const settlement = state.settlement as Record<string, unknown>;
      settlement.transaction = ` ${settlement.transaction as string}`;
    });
    assert.equal(replay.ready(), false);
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "corrupt");
  });

  test("attaching publishes a durable authenticated retention hold", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const name = ".report-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.replay-hold";
    const hold = JSON.parse(readFileSync(`${temp.dir}/${name}`, "utf8"));
    assert.deepEqual(
      {
        v: hold.v,
        reportId: hold.reportId,
        fingerprint: hold.fingerprint,
        attemptToken: hold.attemptToken,
      },
      {
        v: 1,
        reportId: REPORT_A,
        fingerprint,
        attemptToken: begun.attemptToken,
      },
    );
    assert.match(hold.mac, /^[a-f0-9]{64}$/);
  });

  test("stores no raw payment signature or decoded authorization", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    const file = readdirSync(temp.dir).find((name) => name.endsWith(".state"));
    assert.ok(file);
    const body = readFileSync(`${temp.dir}/${file}`, "utf8");
    assert.equal(body.includes(String(payload.payload.signature)), false);
    assert.equal(body.includes(String(payload.payload.authorization.nonce)), false);
    assert.equal(body.includes("authorization"), false);
  });

  test("unknown settlement remains fail-closed with a stable reconciliation id", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_B);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_B), true);
    assert.equal(
      replay.markUnknown(
        fingerprint,
        begun.attemptToken,
        "settlement_unreachable",
        { reportId: REPORT_B },
      ),
      true,
    );
    const retry = replay.begin(fingerprint, request, requirements);
    assert.equal(retry.kind, "in_flight");
    assert.equal(replay.reconciliationId(fingerprint), `pay_${fingerprint.slice(0, 24)}`);
  });

  test("one payment cannot be attached to two report candidates", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    assert.equal(
      replay.attachReport(fingerprint, begun.attemptToken, REPORT_B),
      false,
    );
    const state = replay.reconcileState(fingerprint, begun.attemptToken);
    assert.equal(state.kind, "owned");
    if (state.kind === "owned") assert.equal(state.state.reportId, REPORT_A);
  });

  test("unknown and confirmed transitions cannot replace an attached report", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    assert.equal(
      replay.markUnknown(fingerprint, begun.attemptToken, "settlement_unreachable", {
        reportId: REPORT_B,
      }),
      false,
    );
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_B, {
        transaction: "0x" + "33".repeat(32),
        network: "eip155:196",
      }),
      false,
    );
    const state = replay.reconcileState(fingerprint, begun.attemptToken);
    assert.equal(state.kind, "owned");
    if (state.kind === "owned") {
      assert.equal(state.state.status, "pending");
      assert.equal(state.state.reportId, REPORT_A);
    }
  });

  test("confirmed finalization is idempotent only for identical settlement metadata", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const settlement: replay.ReplaySettlement = {
      transaction: "0x" + "33".repeat(32),
      network: "eip155:196",
      amount: "10000",
      payer: "0x" + "44".repeat(20),
    };
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, settlement),
      true,
    );
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, {
        ...settlement,
        network: "eip155:1",
      }),
      false,
    );
  });

  test("unknown settlement identity cannot be replaced during finalization", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const expected: replay.ReplaySettlement = {
      transaction: "0x" + "45".repeat(32),
      network: requirements.network,
      amount: requirements.amount,
    };
    assert.equal(
      replay.markUnknown(
        fingerprint,
        begun.attemptToken,
        "replay_commit_failed",
        {
          reportId: REPORT_A,
          settlement: expected,
          settlementEvidence: "confirmed",
        },
      ),
      true,
    );
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, {
        ...expected,
        transaction: "0x" + "46".repeat(32),
      }),
      false,
    );
    const state = replay.reconcileState(fingerprint, begun.attemptToken);
    assert.equal(state.kind, "owned");
    if (state.kind === "owned") {
      assert.equal(state.state.status, "unknown");
      assert.deepEqual(state.state.settlement, expected);
    }
  });

  test("a proven transaction conflict can adopt only its named authoritative owner", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    saveReport(REPORT_B);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const settlement: replay.ReplaySettlement = {
      transaction: "0x" + "55".repeat(32),
      network: "eip155:196",
      amount: "10000",
    };
    assert.equal(
      replay.adoptConflictOwner(
        fingerprint,
        begun.attemptToken,
        REPORT_B,
        REPORT_A,
        settlement,
      ),
      false,
      "the expected staged owner cannot be guessed or replaced",
    );
    assert.equal(
      replay.adoptConflictOwner(
        fingerprint,
        begun.attemptToken,
        REPORT_A,
        REPORT_B,
        settlement,
      ),
      true,
    );
    const state = replay.begin(fingerprint, request, requirements);
    assert.equal(state.kind, "confirmed");
    if (state.kind === "confirmed") assert.equal(state.state.reportId, REPORT_B);
    assert.equal(
      existsSync(`${temp.dir}/.report-${REPORT_A}.replay-hold`),
      false,
      "the superseded candidate hold is redundant after authoritative adoption",
    );
  });

  test("confirmed finalization removes the redundant replay hold", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, {
        transaction: "0x" + "66".repeat(32),
        network: "eip155:196",
      }),
      true,
    );
    assert.equal(existsSync(`${temp.dir}/.report-${REPORT_A}.replay-hold`), false);
  });

  test("confirmed state remains recoverable if the redundant hold survived a crash", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const holdPath = `${temp.dir}/.report-${REPORT_A}.replay-hold`;
    const holdBody = readFileSync(holdPath, "utf8");
    const settlement: replay.ReplaySettlement = {
      transaction: "0x" + "67".repeat(32),
      network: "eip155:196",
    };
    assert.equal(
      archive.linkConfirmedSettlement(REPORT_A, {
        status: "confirmed",
        ...settlement,
      }).kind,
      "linked",
    );
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, settlement),
      true,
    );
    assert.equal(existsSync(holdPath), false);

    // Model a crash after the confirmed state replacement but before the hold
    // unlink was durably observed by the filesystem.
    writeFileSync(holdPath, holdBody);
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "confirmed");
    assert.equal(archive.readiness().ready, true);
    assert.equal(existsSync(holdPath), false, "readiness removes the proven redundant hold");
  });

  test("readiness removes a superseded candidate hold after conflict adoption", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    saveReport(REPORT_B);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const holdPath = `${temp.dir}/.report-${REPORT_A}.replay-hold`;
    const holdBody = readFileSync(holdPath, "utf8");
    const settlement: replay.ReplaySettlement = {
      transaction: "0x" + "6a".repeat(32),
      network: requirements.network,
    };
    assert.equal(
      archive.linkConfirmedSettlement(REPORT_B, {
        status: "confirmed",
        ...settlement,
      }).kind,
      "linked",
    );
    assert.equal(
      replay.adoptConflictOwner(
        fingerprint,
        begun.attemptToken,
        REPORT_A,
        REPORT_B,
        settlement,
      ),
      true,
    );
    assert.equal(existsSync(holdPath), false);

    // Model a crash after the confirmed owner replacement but before the
    // losing hold unlink became durable.
    writeFileSync(holdPath, holdBody);
    assert.equal(archive.readiness().ready, true);
    assert.equal(existsSync(holdPath), false);
    assert.equal(archive.byId(REPORT_A)?.id, REPORT_A);
    assert.equal(archive.byTransaction(settlement.transaction)?.id, REPORT_B);
  });

  test("unknown states require valid reasons and reason-specific evidence", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    assert.equal(
      replay.markUnknown(
        fingerprint,
        begun.attemptToken,
        "not-a-reason" as replay.ReplayUnknownReason,
      ),
      false,
    );
    assert.equal(
      replay.markUnknown(fingerprint, begun.attemptToken, "settlement_unreachable"),
      false,
    );
    assert.equal(
      replay.markUnknown(fingerprint, begun.attemptToken, "replay_commit_failed", {
        reportId: REPORT_A,
      }),
      false,
    );
  });

  test("candidate timeout evidence cannot be finalized before a status confirmation", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const settlement: replay.ReplaySettlement = {
      transaction: "0x" + "47".repeat(32),
      network: requirements.network,
      amount: requirements.amount,
    };
    assert.equal(
      replay.markUnknown(
        fingerprint,
        begun.attemptToken,
        "settlement_timeout",
        {
          reportId: REPORT_A,
          settlement,
          settlementEvidence: "candidate",
        },
      ),
      true,
    );
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, settlement),
      false,
    );
    assert.equal(
      replay.confirmSettlementCandidate(
        fingerprint,
        begun.attemptToken,
        settlement,
      ),
      true,
    );
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, settlement),
      true,
    );
  });

  test("unknown transitions cannot introduce an unattached report owner", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(
      replay.markUnknown(
        fingerprint,
        begun.attemptToken,
        "settlement_unreachable",
        { reportId: REPORT_A },
      ),
      false,
      "only attachReport may bind replay state to archive bytes",
    );
    const state = replay.reconcileState(fingerprint, begun.attemptToken);
    assert.equal(state.kind, "owned");
    if (state.kind === "owned") assert.equal(state.state.reportId, undefined);
  });

  test("an unknown state can attach only a report with confirmed archive ownership", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    const settlement = {
      transaction: "0x" + "68".repeat(32),
      network: "eip155:196",
    };
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    assert.equal(
      replay.markUnknown(fingerprint, begun.attemptToken, "archive_link_failed", {
        reportId: REPORT_A,
        settlement,
        settlementEvidence: "confirmed",
      }),
      true,
    );
    const holdPath = `${temp.dir}/.report-${REPORT_A}.replay-hold`;
    unlinkSync(holdPath);
    assert.equal(
      replay.attachReport(fingerprint, begun.attemptToken, REPORT_A),
      false,
      "unknown replay state alone cannot recreate retention for unproven bytes",
    );

    // Once the archive itself proves the confirmed transaction, retry may
    // reconstruct the missing hold before continuing reconciliation.
    assert.equal(
      archive.linkConfirmedSettlement(REPORT_A, {
        status: "confirmed",
        ...settlement,
      }).kind,
      "linked",
    );
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
  });

  test("public fingerprint and reconciliation helpers fail closed on invalid values", () => {
    assert.equal(replay.fingerprintPayment({ impossible: 1n }, requirements), null);
    assert.equal(replay.reconciliationId("not-a-fingerprint"), null);
  });

  test("a definite verification refusal releases the pending fingerprint", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    assert.equal(replay.release(fingerprint, begun.attemptToken), true);
    assert.equal(replay.begin(fingerprint, request, requirements).kind, "created");
  });

  test("definite release removes its retention hold after replay ownership", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const hold = `${temp.dir}/.report-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.replay-hold`;
    assert.equal(existsSync(hold), true);
    assert.equal(replay.release(fingerprint, begun.attemptToken), true);
    assert.equal(existsSync(hold), false);
  });

  test("archive readiness repairs a crash after hold publication but before replay attachment", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);

    // Restore the exact authenticated pending owner from immediately before
    // attachReport replaced it, while preserving the already-published hold.
    const statePath = `${temp.dir}/.payment-${fingerprint}.state`;
    remacState(statePath, (state) => {
      delete state.reportId;
    });

    assert.equal(archive.readiness().ready, true);
    const repaired = replay.reconcileState(fingerprint, begun.attemptToken);
    assert.equal(repaired.kind, "owned");
    if (repaired.kind === "owned") {
      assert.equal(repaired.state.status, "pending");
      assert.equal(repaired.state.reportId, REPORT_A);
    }
    assert.equal(
      replay.begin(fingerprint, request, requirements).kind,
      "in_flight",
      "the repaired payment stays owned and cannot settle twice",
    );
    assert.equal(archive.discard(REPORT_A), false);
    assert.equal(archive.byId(REPORT_A)?.id, REPORT_A);
  });

  test("archive readiness removes the safe hold residue of a release crash", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);

    // release() unlinks state before its hold. Model a process dying at that
    // boundary, while the staged report is still entirely unowned.
    const statePath = `${temp.dir}/.payment-${fingerprint}.state`;
    const holdPath = `${temp.dir}/.report-${REPORT_A}.replay-hold`;
    unlinkSync(statePath);
    assert.equal(existsSync(holdPath), true);

    assert.equal(archive.readiness().ready, true);
    assert.equal(existsSync(holdPath), false);
    assert.equal(
      replay.begin(fingerprint, request, requirements).kind,
      "created",
      "the definitely-unpaid fingerprint is reusable after reconciliation",
    );
  });

  test("archive readiness preserves a release residue when a durable claim owns the report", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const reportPath = `${temp.dir}/${REPORT_A}.json`;
    const stagedBody = readFileSync(reportPath, "utf8");
    const settlement = {
      status: "confirmed" as const,
      transaction: "0x" + "69".repeat(32),
      network: requirements.network,
    };
    assert.equal(archive.linkConfirmedSettlement(REPORT_A, settlement).kind, "linked");
    // Preserve only the authoritative claim, modelling the crash before the
    // convenience settlement fields were merged back into the report.
    writeFileSync(reportPath, stagedBody);
    archive.resetIndex();

    const statePath = `${temp.dir}/.payment-${fingerprint}.state`;
    const holdPath = `${temp.dir}/.report-${REPORT_A}.replay-hold`;
    unlinkSync(statePath);
    assert.equal(archive.readiness().ready, false);
    assert.equal(
      existsSync(holdPath),
      true,
      "uncertain paid ownership must remain retained for operator reconciliation",
    );
  });

  test("archive readiness preserves a release residue for a job-owned report", () => {
    const jobId = "0x" + "ab".repeat(32);
    assert.equal(
      archive.save({
        id: REPORT_A,
        paramsSha256: request.paramsSha256,
        request: { tokenAddress: "0xabc" },
        contentType: request.contentType,
        deliverable: `report-${REPORT_A}`,
        deliveredAt: new Date().toISOString(),
        jobId,
      }),
      true,
    );
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);

    const statePath = `${temp.dir}/.payment-${fingerprint}.state`;
    const holdPath = `${temp.dir}/.report-${REPORT_A}.replay-hold`;
    unlinkSync(statePath);
    assert.equal(archive.readiness().ready, false);
    assert.equal(existsSync(holdPath), true);
  });

  test("readiness checks durable storage, not only key presence", () => {
    const previous = process.env.ARCHIVE_DIR;
    process.env.ARCHIVE_DIR = "/dev/null/dossier-payment-replay";
    try {
      assert.equal(replay.ready(), false);
      assert.equal(
        replay.begin("a".repeat(64), request, requirements).kind,
        "unavailable",
      );
    } finally {
      process.env.ARCHIVE_DIR = previous ?? temp.dir;
    }
  });

  test("readiness rejects corrupt replay state and attached state without its hold", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    const statePath = `${temp.dir}/.payment-${fingerprint}.state`;
    const validState = readFileSync(statePath, "utf8");
    writeFileSync(statePath, "{");
    assert.equal(replay.ready(), false, "malformed authenticated state blocks payments");

    writeFileSync(statePath, validState);
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    unlinkSync(`${temp.dir}/.report-${REPORT_A}.replay-hold`);
    assert.equal(
      replay.ready(),
      false,
      "an attached unsettled state must retain its report-indexed hold",
    );
  });

  test("readiness rejects a confirmed replay whose archive owner disappeared", () => {
    const fingerprint = replay.fingerprintPayment(payload, requirements)!;
    const begun = replay.begin(fingerprint, request, requirements);
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    saveReport(REPORT_A);
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, REPORT_A), true);
    const settlement = {
      transaction: "0x" + "77".repeat(32),
      network: requirements.network,
      amount: requirements.amount,
    };
    assert.equal(
      archive.linkConfirmedSettlement(REPORT_A, {
        status: "confirmed",
        ...settlement,
      }).kind,
      "linked",
    );
    assert.equal(
      replay.finalize(fingerprint, begun.attemptToken, REPORT_A, settlement),
      true,
    );
    assert.equal(replay.ready(), true);

    // Model loss/corruption of the immutable owner while its replay tombstone
    // survives. New payments must fail closed rather than accept more work with
    // a recovery index that can no longer honor an already-confirmed retry.
    unlinkSync(`${temp.dir}/${REPORT_A}.json`);
    assert.equal(replay.ready(), false);
  });
});
