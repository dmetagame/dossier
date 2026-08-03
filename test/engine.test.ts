// The engine's promise is determinism: the same token and the same data produce
// the same report, every time. These tests hold it to that against recorded
// upstream responses, and check that an outage is never mistaken for knowledge.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { stubUpstream, withStub, ADDR } from "./helpers";
import { evaluate, fetchSources, SourcesUnavailableError, honeypotCheck as sellability, controlCheck } from "../src/engine/engine";
import { taxPct } from "../src/engine/sources/goplus";

let restore: () => void;
before(() => {
  restore = stubUpstream();
});
after(() => restore());

describe("deterministic scoring", () => {
  test("the same inputs produce a byte-identical verdict", async () => {
    const req = { chain: "bsc", tokenAddress: ADDR.cake, action: "buy" } as const;
    const a = await evaluate(req);
    const b = await evaluate(req);
    const strip = (v: unknown) => {
      const c = structuredClone(v) as { meta: Record<string, unknown> };
      delete c.meta.generatedAt; // wall clock
      delete c.meta.latencyMs;
      return JSON.stringify(c);
    };
    assert.equal(strip(a), strip(b));
  });

  test("a full-coverage token scores every check", async () => {
    const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.cake, action: "buy" });
    assert.equal(v.confidence, 1);
    assert.equal(Object.values(v.checks).filter((c) => c.status === "unknown").length, 0);
    assert.deepEqual(v.meta.sources.sort(), ["dexscreener", "goplus", "rpc"]);
  });

  test("the size cap comes off the deepest pool, never the sum", async () => {
    const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.cake, action: "buy" });
    const { deepestPoolUsd, liquidityUsd } = v.token;
    assert.ok(deepestPoolUsd && liquidityUsd);
    assert.ok(deepestPoolUsd <= liquidityUsd, "deepest pool cannot exceed the aggregate");
    assert.ok(v.maxSizeUsd! <= Math.floor(deepestPoolUsd * 0.01) + 1);
  });

  test("an explicit amount caps the size but never raises it", async () => {
    const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.cake, action: "buy", amountUsd: 10 });
    assert.equal(v.maxSizeUsd, 10);
    const huge = await evaluate({
      chain: "bsc",
      tokenAddress: ADDR.cake,
      action: "buy",
      amountUsd: 10_000_000,
    });
    assert.ok(huge.maxSizeUsd! < 10_000_000);
    assert.ok(huge.reasons.some((r) => /exceeds the heuristic size cap/.test(r)));
  });
});

describe("partial coverage is disclosed, not filled in", () => {
  test("X Layer USD₮0 has security data but no market on its own chain", async () => {
    const { sec, market } = await fetchSources("xlayer", ADDR.usdt0);
    assert.equal(sec.status, "ok");
    assert.equal(market.status, "not_found", "no dexscreener pair on xlayer for this address");
  });

  test("coverage drops and the market fields stay undefined", async () => {
    const v = await evaluate({ chain: "xlayer", tokenAddress: ADDR.usdt0, action: "buy" });
    assert.ok(v.confidence < 1, `expected partial coverage, got ${v.confidence}`);
    assert.equal(v.token.priceUsd, undefined);
    assert.equal(v.token.liquidityUsd, undefined);
    assert.equal(v.maxSizeUsd, null, "no liquidity means no size cap, not a guessed one");
    assert.ok(v.reasons.some((r) => /No data for/.test(r)));
  });
});

describe("an outage is never treated as knowledge", () => {
  test("both sources down throws rather than returning a verdict", async () => {
    restore();
    await withStub({ fail: { goplus: "timeout", dexscreener: "timeout", rpc: "timeout" } }, () =>
      assert.rejects(
        () => evaluate({ chain: "bsc", tokenAddress: ADDR.cake, action: "buy" }),
        SourcesUnavailableError,
      ),
    );
    restore = stubUpstream();
  });

  test("a failed source is never credited, and its checks stay unknown", async () => {
    restore();
    await withStub({ fail: { goplus: "500", rpc: "500" } }, async () => {
      const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.cake, action: "buy" });
      assert.equal(v.checks.honeypot.status, "unknown");
      assert.equal(v.checks.contractControl.status, "unknown");
      assert.ok(!v.meta.sources.includes("goplus"));
      assert.ok(!v.meta.sources.includes("rpc"));
      assert.ok(v.confidence < 1);
    });
    restore = stubUpstream();
  });

  test("with the security source down, the chain still answers contract control", async () => {
    // The point of reading the chain directly: a check that used to go blank
    // is now answered from primary evidence.
    restore();
    await withStub({ fail: { goplus: "500" } }, async () => {
      const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.cake, action: "buy" });
      assert.notEqual(v.checks.contractControl.status, "unknown");
      assert.match(v.checks.contractControl.detail, /read from the chain/);
      assert.ok(v.meta.sources.includes("rpc"));
    });
    restore = stubUpstream();
  });
});

describe("a token nothing has heard of", () => {
  test("both sources answer not_found, and the verdict is abort", async () => {
    const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.nowhere, action: "buy" });
    assert.equal(v.verdict, "abort");
    assert.equal(v.maxSizeUsd, null);
    assert.ok(v.reasons.some((r) => /untradeable/i.test(r)));
  });

  test("the chain says plainly that there is no contract there", async () => {
    const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.nowhere, action: "buy" });
    assert.equal(v.checks.contractControl.status, "fail");
    assert.match(v.checks.contractControl.detail, /no contract code/i);
  });
});

describe("absent tax data is a warning, not a pass", () => {
  test("no reported taxes cannot produce a clean sellability pass", async () => {
    const v = await evaluate({ chain: "bsc", tokenAddress: ADDR.cake, action: "buy" });
    const s = v.checks.honeypot;
    if (s.status === "pass") {
      assert.ok(/tax/.test(s.detail), "a pass must state the tax figures it saw");
    } else {
      assert.equal(s.status, "warn");
      assert.ok(/tax/.test(s.detail) && /not reported|neither/.test(s.detail),
        `a warning must name what was missing, got: ${s.detail}`);
    }
  });

  // Number("") and Number(" ") are both 0, so a tax the source simply omitted
  // used to be reported as a measured 0% and counted as covered. The committed
  // fixture carries `"buy_tax": ""`, so this shipped.
  test("a blank tax string is unknown, never a measured zero", () => {
    for (const blank of ["", "   ", "\t", null, undefined, {}, []]) {
      assert.equal(taxPct(blank), undefined, `${JSON.stringify(blank)} must not become a number`);
    }
    assert.equal(taxPct("0"), 0, "an explicit zero is still a measurement");
    assert.equal(taxPct("0.05"), 5);
  });

  test("nonsensical tax values are rejected rather than reported", () => {
    for (const bad of ["-0.1", "1.5", "abc", "NaN", "Infinity"]) {
      assert.equal(taxPct(bad), undefined, `${bad} must not be reported as a tax`);
    }
  });

  // Sell tax is the side that traps a buyer. Knowing the buy side says nothing
  // about it, and defaulting it to zero let a token pass as "sell 0%" when the
  // sell tax had never been reported at all.
  test("a known buy tax does not license a clean pass on an unknown sell tax", () => {
    const r = sellability({ status: "ok", buyTaxPct: 0, sellTaxPct: undefined });
    assert.equal(r.status, "warn");
    assert.match(r.detail, /sell tax was not reported/i);
  });

  test("a known sell tax with an unknown buy tax still warns", () => {
    const r = sellability({ status: "ok", buyTaxPct: undefined, sellTaxPct: 0 });
    assert.equal(r.status, "warn");
    assert.match(r.detail, /buy tax was not reported/i);
  });

  test("both sides known and clean is the only route to a pass", () => {
    assert.equal(sellability({ status: "ok", buyTaxPct: 0, sellTaxPct: 0 }).status, "pass");
  });

  test("a punitive sell tax fails even when the buy side is missing", () => {
    const r = sellability({ status: "ok", buyTaxPct: undefined, sellTaxPct: 30 });
    assert.equal(r.status, "fail");
  });
});

// A sparse but "ok" security record used to silence the chain completely, so a
// report could print an EIP-1967 implementation and mint or pause selectors read
// from the deployed bytecode while the scored check beside it said "No dangerous
// owner powers detected". Absent is not false.
describe("contract control merges both sources", () => {
  const chainClean = { status: "ok", isContract: true, capabilities: [] } as any;
  const chainProxy = {
    status: "ok", isContract: true, proxyImplementation: "0xabc", capabilities: [],
  } as any;
  const chainDangerous = {
    status: "ok", isContract: true, capabilities: ["pause", "blacklist"],
  } as any;

  test("a proxy seen only on chain is not erased by a silent aggregator", () => {
    const r = controlCheck({ status: "ok" } as any, chainProxy);
    assert.notEqual(r.status, "pass", "an implementation slot is evidence, not noise");
    assert.match(r.detail, /proxy/i);
  });

  test("pause and blacklist powers reach the score, not just the prose", () => {
    // GoPlus does not report these at all, so before the merge they were visible
    // in the report and absent from the verdict.
    const r = controlCheck({ status: "ok" } as any, chainDangerous);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /pausable/);
    assert.match(r.detail, /blacklist/);
  });

  test("a mint selector plus an active owner counts even if GoPlus is quiet", () => {
    const chain = { status: "ok", isContract: true, capabilities: ["mint"], ownerRenounced: false } as any;
    const r = controlCheck({ status: "ok" } as any, chain);
    assert.notEqual(r.status, "pass");
    assert.match(r.detail, /mint/i);
  });

  test("a clean pass names the evidence it rests on", () => {
    const r = controlCheck({ status: "ok", isProxy: false } as any, chainClean);
    assert.equal(r.status, "pass");
    assert.match(r.detail, /bytecode/, "a pass on both sources should say so");
  });

  test("a pass with no chain read says the chain was not read", () => {
    const r = controlCheck({ status: "ok", isProxy: false } as any, { status: "unavailable" } as any);
    assert.equal(r.status, "pass");
    assert.match(r.detail, /chain could not be read/i);
  });

  test("the owner-can-change-balance finding still short-circuits everything", () => {
    const r = controlCheck({ status: "ok", ownerCanChangeBalance: true } as any, chainClean);
    assert.equal(r.status, "fail");
  });
});
