// Paid routing is wired once when the app module loads. This production-shaped
// process proves that setting strict mode early cannot bypass the mandatory
// cold-archive disposition for request-keyed v1 records.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ADDR, stubUpstream, tempArchive } from "./helpers";

delete process.env.DEV_SKIP_PAYMENT;
process.env.NODE_ENV = "production";
process.env.PAY_TO = "0x51c25782af63381056cd1c3c59c0544628d67697";
process.env.OKX_API_KEY = "configured-but-unused-test-key";
process.env.OKX_SECRET_KEY = "configured-but-unused-test-secret";
process.env.OKX_PASSPHRASE = "configured-but-unused-test-passphrase";
process.env.INTERNAL_KEY = "strict-legacy-gate-internal-key";
process.env.PAYMENT_REPLAY_KEY = "strict-legacy-gate-replay-key";
process.env.ARCHIVE_MAC_KEY = "strict-legacy-gate-archive-key";
process.env.ARCHIVE_MAC_REQUIRED = "1";

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;
const legacyHash = "a".repeat(64);
writeFileSync(
  join(dir, `${legacyHash}.json`),
  JSON.stringify({
    paramsSha256: legacyHash,
    request: { tokenAddress: ADDR.cake },
    contentType: "text/html",
    deliverable: "legacy report",
    deliveredAt: new Date().toISOString(),
  }),
);

const { app, paymentLayerState } = await import("../src/app");

let restore: () => void;
before(() => {
  restore = stubUpstream();
});
after(() => {
  restore();
  cleanup();
});

describe("legacy archive payment gate", () => {
  test("strict mode stays dark until legacy v1 records leave the active archive", async () => {
    const health = (await (await app.request("/health")).json()) as Record<
      string,
      unknown
    >;
    assert.equal(health.archiveMode, "strict");
    assert.equal(health.archiveReady, false);
    assert.equal(health.paidReady, false);
    assert.match(String(health.archiveReadinessReason), /cold-archive migration/);
    assert.equal(paymentLayerState(), "not_configured");

    const response = await app.request(`/dossier?tokenAddress=${ADDR.cake}`);
    assert.equal(response.status, 503);
    assert.match(
      String(((await response.json()) as Record<string, unknown>).error),
      /recovery and payment replay state not ready/,
    );
  });
});
