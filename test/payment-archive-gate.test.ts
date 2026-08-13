// Paid routing is wired once when the app module loads, so this production-like
// unsigned-archive case needs its own test process. It proves that valid-looking
// payment configuration cannot enable external traffic before archive migration
// reaches authenticated strict mode, while the already-paid internal fulfilment
// path remains available.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { ADDR, stubUpstream, tempArchive } from "./helpers";

delete process.env.DEV_SKIP_PAYMENT;
process.env.NODE_ENV = "production";
process.env.PAY_TO = "0x51c25782af63381056cd1c3c59c0544628d67697";
process.env.OKX_API_KEY = "configured-but-unused-test-key";
process.env.OKX_SECRET_KEY = "configured-but-unused-test-secret";
process.env.OKX_PASSPHRASE = "configured-but-unused-test-passphrase";
process.env.INTERNAL_KEY = "strict-gate-internal-key";
process.env.PAYMENT_REPLAY_KEY = "strict-gate-replay-key";
delete process.env.ARCHIVE_MAC_KEY;
delete process.env.ARCHIVE_MAC_REQUIRED;

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;

const { app, paymentLayerState } = await import("../src/app");

let restore: () => void;
before(() => {
  restore = stubUpstream();
});
after(() => {
  restore();
  cleanup();
});

const call = (headers: Record<string, string> = {}) =>
  app.request("/dossier", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      tokenAddress: ADDR.cake,
      chain: "ethereum",
      format: "json",
    }),
  });

describe("external payment archive gate", () => {
  test("configured payments stay dark while the archive is unsigned", async () => {
    const health = (await (await app.request("/health")).json()) as Record<
      string,
      unknown
    >;
    assert.equal(health.paymentConfigured, true);
    assert.equal(health.archiveMode, "unsigned");
    assert.equal(health.archiveMacConfigured, false);
    assert.equal(health.archiveMacRequired, false);
    assert.equal(health.paidReady, false);
    assert.equal(paymentLayerState(), "not_configured");

    const response = await call();
    assert.equal(response.status, 503);
    assert.match(
      String(((await response.json()) as Record<string, unknown>).error),
      /recovery and payment replay state not ready/,
    );
  });

  test("the internal task fulfilment path remains explicitly exempt", async () => {
    const response = await call({
      "x-internal-key": process.env.INTERNAL_KEY!,
      "x-job-id": "0x" + "cd".repeat(32),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.ok(body.riskVerdict, "the exempt path still builds the owed report");
  });
});
