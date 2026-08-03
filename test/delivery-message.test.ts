// The buyer-facing delivery message, which the service now generates itself.
//
// The reason is a line that reached a real buyer on 2026-08-03:
//
//     VERDICT: CAUTION (confidence 100%) — safe position size ≈ $78,345
//
// for a token the next line flagged as mintable with an unrenounced owner. The
// number is 1% of the deepest pool's base-side liquidity, halved on caution.
// The report calls it a heuristic size cap; only the delivery message, composed
// by a language model from a prompt, called it safe.
//
// These tests are the reason that cannot happen again: the words are fixed
// here, in code, and every sender pastes rather than paraphrases.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderDeliveryMessage } from "../src/dossier/message";
import type { Dossier } from "../src/dossier/report";

const D = {
  title: "t",
  generatedAt: "2026-08-03T00:00:00.000Z",
  token: {
    chain: "ethereum",
    address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    symbol: "UNI",
    priceUsd: 3.93,
    liquidityUsd: 31_282_001,
    volume24hUsd: 3_072_390,
    holderCount: 389_159,
  },
  riskVerdict: {
    verdict: "caution",
    confidence: 1,
    maxSizeUsd: 78_345,
    reasons: ["Contract control risk: mint function present, owner not renounced."],
  },
  security: {},
  sources: ["GoPlus", "DexScreener", "ethereum RPC"],
  chainResolution: { source: "specified", ambiguous: false, alternatives: [] },
} as unknown as Dossier;

const CTX = { endpoint: "https://dossier.rouma.xyz/dossier" };

describe("the delivery message", () => {
  test("calls the size cap what the report calls it, never 'safe'", () => {
    const m = renderDeliveryMessage(D, CTX);
    assert.match(m, /heuristic size cap \$78,345/);
    assert.ok(
      !/safe position size/i.test(m),
      "the exact wording that reached a buyer on 2026-08-03 must not be reproducible",
    );
    // Nothing anywhere in the message may call a position safe.
    assert.ok(!/\bsafe\b/i.test(m), "no part of this message may describe a position as safe");
  });

  test("never asks the buyer for money", () => {
    const m = renderDeliveryMessage(D, CTX).toLowerCase();
    for (const phrase of ["re-run your", "pay again", "resend payment", "task payment"]) {
      assert.ok(!m.includes(phrase), `must not contain ${phrase}`);
    }
    assert.match(m, /you owe nothing further/i);
  });

  test("states the verdict and the contract it applies to", () => {
    const m = renderDeliveryMessage(D, CTX);
    assert.match(m, /VERDICT: CAUTION/);
    assert.match(m, /data coverage 100%/);
    assert.ok(m.includes(D.token.address), "a verdict without its contract is unusable");
    assert.match(m, /mint function present/, "every reason must survive into the message");
  });

  test("prices are decimal, never scientific notation", () => {
    const tiny = { ...D, token: { ...D.token, priceUsd: 2.932e-6 } } as Dossier;
    const m = renderDeliveryMessage(tiny, CTX);
    assert.match(m, /0\.000002932/);
    assert.ok(!/e-\d/.test(m), "a buyer cannot tell 2.932e-06 from a typo");
  });

  test("a job delivery carries its recovery code and says it cannot be reissued", () => {
    const m = renderDeliveryMessage(D, { ...CTX, jobId: "0xjob", recoveryCode: "abc123" });
    assert.match(m, /"recoveryCode":"abc123"/);
    assert.match(m, /Keep that code/);
    assert.ok(!m.includes("originalBody"), "the guessable form must not be offered beside it");
  });

  test("without a code the older instructions still ship", () => {
    const m = renderDeliveryMessage(D, { ...CTX, jobId: "0xjob" });
    assert.match(m, /originalBody/);
  });

  test("an x402 delivery gets no recovery block at all", () => {
    // No job id means the buyer holds a settlement transaction, which recovers
    // on its own; printing job-id instructions they cannot use is noise.
    const m = renderDeliveryMessage(D, CTX);
    assert.ok(!m.includes("LOST THIS REPORT"), "no job, no job-id instructions");
  });

  test("a ticker-resolved token says so", () => {
    const m = renderDeliveryMessage(D, { ...CTX, fromTicker: true });
    assert.match(m, /resolved from the ticker/);
    assert.ok(!renderDeliveryMessage(D, CTX).includes("resolved from the ticker"));
  });

  test("the attachment slot is a marker, not prose to be improvised", () => {
    const m = renderDeliveryMessage(D, CTX);
    assert.ok(m.includes("ATTACHMENT_BLOCK"), "senders substitute one line and edit nothing else");
  });

  test("missing numbers read as n/a rather than undefined or NaN", () => {
    const bare = {
      ...D,
      token: { chain: "xlayer", address: D.token.address, symbol: "X" },
      riskVerdict: { ...D.riskVerdict, maxSizeUsd: null, reasons: [] },
    } as unknown as Dossier;
    const m = renderDeliveryMessage(bare, CTX);
    assert.ok(!/undefined|NaN|\$null/.test(m), m);
    assert.match(m, /heuristic size cap n\/a/);
  });
});
