// The engine's promise is determinism: the same token and the same data produce
// the same report, every time. These tests hold it to that against recorded
// upstream responses, and check that an outage is never mistaken for knowledge.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { stubUpstream, withStub, ADDR } from "./helpers";
import { evaluate, fetchSources, SourcesUnavailableError, honeypotCheck as sellability, controlCheck, activityCheck } from "../src/engine/engine";
import { taxPct } from "../src/engine/sources/goplus";
import { comparableLiquidity, finiteUsd, ageInDays, fetchDexScreener } from "../src/engine/sources/dexscreener";
import { formatUnits } from "../src/engine/sources/rpc";
import { preflight } from "../src/dossier/report";

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

// Chain ranking and market analysis have to agree on what "deepest" means.
// Ranking summed every pair the token appeared in, on either side, while
// analysis then used base-side pairs whenever any existed. A chain could win on
// quote-side depth the report went on to ignore, and then claim it had picked
// the deepest deployment.
describe("chain resolution measures what the report will measure", () => {
  const addr = "0x" + "a".repeat(40);
  const other = "0x" + "b".repeat(40);
  const pair = (base: string, quote: string, usd: number) => ({
    baseToken: { address: base },
    quoteToken: { address: quote },
    liquidity: { usd },
  });

  test("quote-side depth does not win a chain the report would then ignore", () => {
    // The audit's example: a $1k base pool beside a $500k quote pool must not
    // outrank a $100k base pool, because $1k is all the report would analyse.
    const chainB = [pair(addr, other, 1_000), pair(other, addr, 500_000)];
    const chainA = [pair(addr, other, 100_000)];
    assert.equal(comparableLiquidity(chainB, addr), 1_000);
    assert.equal(comparableLiquidity(chainA, addr), 100_000);
    assert.ok(
      comparableLiquidity(chainA, addr) > comparableLiquidity(chainB, addr),
      "the chain the report can actually analyse must rank higher",
    );
  });

  test("quote-side pools still count for a token that is never the base", () => {
    const onlyQuote = [pair(other, addr, 250_000)];
    assert.equal(comparableLiquidity(onlyQuote, addr), 250_000);
  });

  test("upstream strings are not concatenated into liquidity", () => {
    // 0 + "9000" + "2000" would be "090002000" under `+`.
    const dirty = [pair(addr, other, "9000" as any), pair(addr, other, "2000" as any)];
    assert.equal(comparableLiquidity(dirty, addr), 11_000);
  });

  test("negative, infinite and malformed values contribute nothing", () => {
    for (const bad of [-5, Infinity, NaN, null, undefined, {}, "abc"]) {
      assert.equal(finiteUsd(bad), 0, `${JSON.stringify(bad)} must not survive`);
    }
    assert.equal(finiteUsd(1234), 1234);
    assert.equal(finiteUsd("1234"), 1234);
  });
});

// Resolution and analysis both hit the identical DexScreener URL independently,
// so a report could rank chains on one observation and measure the winner on
// another taken moments later, and the chain it chose was not reproducible from
// the bytes it attests to.
describe("a report describes one DexScreener observation, not two", () => {
  test("auto-detecting a chain does not fetch the same URL twice", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url.includes("dexscreener")) calls.push(url);
      return realFetch(u, init);
    }) as any;
    try {
      await preflight({ tokenAddress: ADDR.cake, format: "html" } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    const tokenCalls = calls.filter((u) => u.includes("/dex/tokens/"));
    assert.equal(
      tokenCalls.length,
      1,
      `chain resolution and market analysis must share one fetch, saw ${tokenCalls.length}`,
    );
  });

  test("an explicit chain also makes exactly one call", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url.includes("dexscreener")) calls.push(url);
      return realFetch(u, init);
    }) as any;
    try {
      await preflight({ tokenAddress: ADDR.cake, chain: "bsc", format: "html" } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls.filter((u) => u.includes("/dex/tokens/")).length, 1);
  });
});

describe("upstream faults are never mistaken for facts", () => {
  // GoPlus answers application errors with HTTP 200 and a non-success code:
  // rate-limit envelopes, service errors, schema changes. Treating any 200
  // without our token as "no security record" turns an outage into knowledge
  // about the token, which is the guarantee this engine is built on.
  test("a 200 carrying a GoPlus error code is unavailable, not not_found", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, init?: any) => {
      if (String(u).includes("gopluslabs")) {
        return new Response(JSON.stringify({ code: 4029, message: "rate limited", result: {} }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return real(u, init);
    }) as any;
    try {
      const { fetchGoPlus } = await import("../src/engine/sources/goplus");
      const r = await fetchGoPlus("bsc", ADDR.cake);
      assert.equal(r.status, "unavailable", "an error envelope is not an empty answer");
    } finally { globalThis.fetch = real; }
  });

  test("a success envelope without our token is genuinely not_found", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, init?: any) => {
      if (String(u).includes("gopluslabs")) {
        return new Response(JSON.stringify({ code: 1, message: "OK", result: {} }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return real(u, init);
    }) as any;
    try {
      const { fetchGoPlus } = await import("../src/engine/sources/goplus");
      assert.equal((await fetchGoPlus("bsc", ADDR.cake)).status, "not_found");
    } finally { globalThis.fetch = real; }
  });

  test("GoPlus provenance now records what the source actually said", async () => {
    const r = await fetchSources("bsc", ADDR.cake);
    if (r.sec.status === "ok") {
      assert.ok(r.sec.provenance?.responseSha256, "a signed report claims to pin each response");
      assert.match(r.sec.provenance!.responseSha256!, /^[a-f0-9]{64}$/);
    }
  });
});

describe("report facts are pinned, not sampled", () => {
  // Owner, implementation slot, bytecode and supply each used "latest" while the
  // height was read in a later chunk, so during an upgrade or an ownership
  // transfer they could come from different blocks while the report attested to
  // a single height that pinned none of them.
  test("every chain read happens at one block, and it is the attested one", async () => {
    const bodies: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, init?: any) => {
      if (init?.method === "POST") bodies.push(String(init.body));
      return real(u, init);
    }) as any;
    let facts: any;
    try {
      const { fetchChainFacts } = await import("../src/engine/sources/rpc");
      facts = await fetchChainFacts("bsc", ADDR.cake);
    } finally { globalThis.fetch = real; }
    assert.equal(facts.status, "ok");
    const tag = "0x" + facts.blockNumber.toString(16);
    const reads = bodies.filter((b) => !b.includes("eth_blockNumber"));
    assert.ok(reads.length > 0, "there should be reads to check");
    for (const b of reads) {
      assert.ok(b.includes(tag), `a read used a different block than the attested ${tag}`);
      assert.equal(b.includes('"latest"'), false, "no read may float to latest");
    }
  });

  test("the chain section is hashed, like every other source the report claims to hash", async () => {
    // The report says of each source that it records the time it was read and a
    // SHA-256 of its response. That was true of GoPlus and DexScreener and not
    // of this one, which recorded only the endpoint and the time, so the
    // sentence covered two sources out of three and a verifier had nothing to
    // check the chain section against.
    const { fetchChainFacts } = await import("../src/engine/sources/rpc");
    const a = await fetchChainFacts("bsc", ADDR.cake);
    assert.equal(a.status, "ok");
    assert.match(
      a.provenance?.responseSha256 ?? "",
      /^[0-9a-f]{64}$/,
      "a source the report says is hashed must actually be hashed",
    );
    assert.ok(a.provenance?.url, "and still says where it came from");

    // Replaying the same fixtures at the same block must reproduce it, or the
    // hash is a random number rather than a commitment.
    const b = await fetchChainFacts("bsc", ADDR.cake);
    assert.equal(
      a.provenance?.responseSha256,
      b.provenance?.responseSha256,
      "the same reads at the same block hash to the same value",
    );
    // A different address on the SAME chain, so the pinned block is identical
    // and only the reads differ. Comparing across chains proved nothing: the
    // block heights differ, so a hash that committed to the height alone and
    // ignored every value read would have passed.
    const other = await fetchChainFacts("bsc", ADDR.nowhere);
    assert.notEqual(
      a.provenance?.responseSha256,
      other.provenance?.responseSha256,
      "the hash must commit to what was read, not just to where and when",
    );
  });

  test("total supply keeps every digit", () => {
    // BigInt division truncated first: 150 raw at 2 decimals became 1, not 1.5.
    assert.equal(formatUnits(150n, 2), "1.5");
    assert.equal(formatUnits(1n, 18), "0.000000000000000001");
    assert.equal(formatUnits(10n ** 30n, 18), "1000000000000");
    assert.equal(formatUnits(0n, 18), "0");
    assert.equal(formatUnits(123n, 0), "123");
  });
});

describe("time is an input, recorded once", () => {
  // Pair age used Date.now() where it ran, and the three-day boundary changes
  // the activity result, so the same captured response could score differently
  // on different days and no verifier could reproduce it.
  const day = 86_400_000;
  test("age is measured against the evaluation time it is given", () => {
    const asOf = 1_800_000_000_000;
    assert.equal(ageInDays(asOf - 3 * day, asOf), 3);
    assert.equal(ageInDays(asOf - day / 2, asOf), 0.5);
  });

  test("the same response scores identically whenever it is replayed", () => {
    const created = 1_700_000_000_000;
    const asOf = created + 10 * day;
    assert.equal(ageInDays(created, asOf), ageInDays(created, asOf));
    assert.notEqual(ageInDays(created, asOf), ageInDays(created, asOf + 5 * day));
  });

  test("a zero age is a measurement, not an absence", () => {
    const asOf = 1_800_000_000_000;
    assert.equal(ageInDays(asOf, asOf), 0);
  });

  test("a materially future timestamp is unknown rather than negative", () => {
    const asOf = 1_800_000_000_000;
    assert.equal(ageInDays(asOf + 5 * day, asOf), undefined);
    assert.equal(ageInDays(asOf + day / 4, asOf), 0, "small clock skew is tolerated");
    for (const bad of [0, -1, null, undefined, "x"]) {
      assert.equal(ageInDays(bad, asOf), undefined);
    }
  });

  // The four tests above pass whether or not anything calls `ageInDays`, and for
  // months nothing did: `fetchDexScreener` computed age inline from the live
  // clock while the helper sat beside it, tested and unused. A helper can only
  // be as load-bearing as its call site, so these check the snapshot the report
  // is actually built from.
  test("the snapshot's age comes from the evaluation time, not the wall clock", async () => {
    const asOf = 1_800_000_000_000;
    const created = asOf - 30 * day;
    const pairs = {
      status: "ok",
      provenance: { url: "https://api.dexscreener.com/…", retrievedAt: "2027-01-15T00:00:00.000Z" },
      pairs: [
        {
          chainId: "bsc",
          baseToken: { address: ADDR.cake, symbol: "Cake" },
          quoteToken: { symbol: "WBNB" },
          liquidity: { usd: 5_000_000 },
          volume: { h24: 1_000_000 },
          txns: { h24: { buys: 100, sells: 100 } },
          priceUsd: "2",
          priceNative: "1",
          pairCreatedAt: created,
        },
      ],
    } as any;

    const a = await fetchDexScreener("bsc", ADDR.cake, pairs, asOf);
    assert.equal(a.ageDays, 30, "the age is measured from the time the report was given");

    const b = await fetchDexScreener("bsc", ADDR.cake, pairs, asOf);
    assert.deepEqual(a, b, "the same data at the same instant is the same snapshot");

    const later = await fetchDexScreener("bsc", ADDR.cake, pairs, asOf + 5 * day);
    assert.equal(later.ageDays, 35, "and a different instant is a different age");
  });

  test("a pool created at the evaluation instant reaches the report as zero", async () => {
    // Inline, the falsy-zero guard dropped an exactly-zero age from the report
    // while the risk checks still scored it, so the document omitted the figure
    // its own verdict rested on.
    const asOf = 1_800_000_000_000;
    const pairs = {
      status: "ok",
      provenance: { url: "https://api.dexscreener.com/…", retrievedAt: "2027-01-15T00:00:00.000Z" },
      pairs: [
        {
          chainId: "bsc",
          baseToken: { address: ADDR.cake, symbol: "Cake" },
          liquidity: { usd: 5_000_000 },
          volume: { h24: 1_000_000 },
          pairCreatedAt: asOf,
        },
      ],
    } as any;
    assert.equal((await fetchDexScreener("bsc", ADDR.cake, pairs, asOf)).ageDays, 0);
  });
});

// Missing volume.h24 collapsed to 0 during aggregation, so a report could state
// "24h volume $0" when DexScreener had simply not supplied the figure, and the
// activity check counted as covered rather than unknown. Same shape as reading a
// blank tax as a measured 0%.
describe("absent volume is unknown, not a measured zero", () => {
  const addr = "0x" + "a".repeat(40);
  const shared = (pairs: any[]) => ({ status: "ok" as const, pairs });
  const p = (vol?: any) => ({
    chainId: "bsc",
    baseToken: { address: addr, symbol: "T" },
    quoteToken: { address: "0x" + "b".repeat(40) },
    liquidity: { usd: 50_000 },
    priceUsd: "1",
    ...(vol === undefined ? {} : { volume: { h24: vol } }),
  });

  test("no pair reporting volume leaves it absent, not zero", async () => {
    const m: any = await fetchDexScreener("bsc", addr, shared([p(), p()]));
    assert.equal(m.status, "ok");
    assert.equal(m.volume24hUsd, undefined, "a figure nobody supplied is not a measurement");
  });

  test("a genuine zero is still reported as zero", async () => {
    const m: any = await fetchDexScreener("bsc", addr, shared([p(0)]));
    assert.equal(m.volume24hUsd, 0);
  });

  test("reported volume still sums", async () => {
    const m: any = await fetchDexScreener("bsc", addr, shared([p(1_000), p(2_500)]));
    assert.equal(m.volume24hUsd, 3_500);
  });

  test("the activity check cannot score on a figure it never received", async () => {
    const m: any = await fetchDexScreener("bsc", addr, shared([p()]));
    const r = activityCheck({ ...m, ageDays: 100 });
    assert.equal(r.status, "unknown", "absent volume must not declare a near-dead market");
    assert.match(r.detail, /did not report 24h volume/);
  });
});
