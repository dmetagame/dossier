// What happens to a paid buyer when the facilitator credentials are gone.
//
// The service fails closed by registering 503 handlers on /dossier the moment
// payment configuration is absent, so a lost env var cannot silently turn a
// paid listing into a free one. That is right for everyone paying over x402.
//
// It was wrong for one caller. A task-mode buyer pays OKX at the task level and
// never signs an x402 payment, so our facilitator credentials have nothing to do
// with whether they are owed a report. The fulfilment daemon fetches it on their
// behalf with a shared secret, and the dark handlers were registered ahead of
// the real one, so during a credential outage the daemon got 503 as well and
// buyers who had already paid could not be served at all.
//
// This file loads the app in that configuration, which needs its own process:
// the payment wiring is decided once at import time.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { stubUpstream, tempArchive, ADDR } from "./helpers";
import * as ratelimit from "../src/ratelimit";

const KEY = "test-internal-key-payment-outage";

// A production-shaped process with no facilitator credentials.
delete process.env.DEV_SKIP_PAYMENT;
process.env.NODE_ENV = "production";
process.env.INTERNAL_KEY = KEY;
for (const v of ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "PAYOUT_ADDRESS"]) {
  delete process.env[v];
}

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;
process.env.PAYMENT_REPLAY_KEY = "payment-outage-replay-key";

const { app } = await import("../src/app");

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
    body: JSON.stringify({ tokenAddress: ADDR.cake, chain: "ethereum", format: "json" }),
  });

describe("a facilitator credential outage", () => {
  test("the app really is in the failed-closed configuration", async () => {
    const h = (await (await app.request("/health")).json()) as Record<string, unknown>;
    assert.equal(h.paymentConfigured, false);
    assert.equal(h.devSkipPayment, false);
    assert.equal(h.paymentLayer, "not_configured");
    assert.equal(h.paidReady, false);
    assert.equal(h.ready, false);
    assert.equal((await app.request("/health/live")).status, 200);
    assert.equal((await app.request("/health/ready")).status, 503);
  });

  test("an external buyer gets 503, never a free report", async () => {
    const r = await call();
    assert.equal(r.status, 503);
    const j = (await r.json()) as Record<string, unknown>;
    assert.match(String(j.error), /payment layer not configured/);
  });

  test("a wrong internal key is treated as external", async () => {
    const r = await call({ "x-internal-key": KEY + "x" });
    assert.equal(r.status, 503, "a near-miss secret must not open the bypass");
  });

  test("the fulfilment daemon can still serve a buyer who already paid", async () => {
    const r = await call({ "x-internal-key": KEY });
    assert.equal(r.status, 200, "a task buyer's report does not depend on our x402 credentials");
    const j = (await r.json()) as Record<string, unknown>;
    assert.ok(j.riskVerdict, "and it is a real report, not an acknowledgement");
  });

  test("the fulfilment daemon bypasses an exhausted unsigned challenge budget", async () => {
    const peer = "198.51.100.44";
    ratelimit.reset();
    for (let i = 0; i < ratelimit.limits["/dossier"]!.max; i++) {
      assert.equal(ratelimit.check("/dossier", peer).limited, false);
    }

    const wrong = await call({
      "x-forwarded-for": peer,
      "x-internal-key": KEY + "x",
    });
    assert.equal(wrong.status, 429, "a near-miss secret remains rate limited");

    const internal = await call({
      "x-forwarded-for": peer,
      "x-internal-key": KEY,
    });
    assert.equal(internal.status, 200, "an authenticated daemon must still reach fulfilment");
    const report = (await internal.json()) as Record<string, unknown>;
    assert.ok(report.riskVerdict, "the bypass reaches the real report handler");
  });

  test("the free surface is untouched by the outage", async () => {
    for (const p of ["/", "/health", "/info", "/dossier/preflight?tokenAddress=" + ADDR.cake]) {
      assert.equal((await app.request(p)).status, 200, p);
    }
  });
});
