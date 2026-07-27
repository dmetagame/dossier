// The engine's promise is determinism: the same token and the same data produce
// the same report, every time. These tests hold it to that against recorded
// upstream responses, and check that an outage is never mistaken for knowledge.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { stubUpstream, withStub, ADDR } from "./helpers";
import { evaluate, fetchSources, SourcesUnavailableError } from "../src/engine/engine";

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
      assert.ok(/did not report trading taxes/.test(s.detail));
    }
  });
});
