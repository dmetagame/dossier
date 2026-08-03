import { createHash } from "node:crypto";
// DexScreener pairs API — free, no key, reachable from the dev box.
// Gives liquidity depth, volume, price, and pair age across chains incl. X Layer.

import type { SourceStatus } from "./goplus";
import { SUPPORTED_CHAINS } from "../schema";

// Cross-chain resolution for "just an address" requests. The tokens endpoint
// already returns pairs on every chain, so one call tells us where the token
// actually trades.
//
// The same address on two chains is two different contracts (bridged
// deployments, and clones deployed at identical addresses), so when several
// match we analyse the deepest-liquidity deployment — the one a buyer almost
// always means — and report which chain was chosen and what the alternatives
// were, so a wrong guess is visible rather than silent. Passing `chain`
// explicitly always wins and skips this entirely.
export type ChainResolution =
  | {
      status: "ok";
      chain: (typeof SUPPORTED_CHAINS)[number];
      ambiguous: boolean;
      alternatives: string[];
      /**
       * Liquidity per candidate chain, under the same rule the report analyses
       * with. Recorded so the choice can be shown rather than asserted: the
       * report used to claim it picked the deepest deployment while ranking on
       * a different metric than it then measured.
       */
      consideredUsd: Record<string, number>;
    }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * The liquidity the report will actually judge, for one chain's pairs.
 *
 * Chain ranking and market analysis have to agree on what "deepest" means. They
 * did not: ranking summed every pair the token appeared in, on either side,
 * while analysis then used base-side pairs whenever any existed. A chain could
 * therefore win on quote-side depth the report went on to ignore, and a token
 * with a $1k base pool plus a $500k quote pool would beat a chain with a $100k
 * base pool, only for the report to analyse the $1k one and claim it had picked
 * the deepest deployment.
 *
 * This is the analysis policy, and it is now the only policy: the token's own
 * markets when it has them, quote-side pools only as a fallback for tokens that
 * never appear as the base.
 */
export function comparableLiquidity(pairs: any[], addr: string): number {
  const base = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === addr);
  const active = base.length ? base : pairs;
  return active.reduce((sum, p) => sum + finiteUsd(p.liquidity?.usd), 0);
}

/** Upstream numbers are untrusted: a string would concatenate under `+`. */
export function finiteUsd(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function resolveChain(address: string): Promise<ChainResolution> {
  let json: { pairs?: any[] } | null = null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: "unavailable" };
    json = (await res.json()) as { pairs?: any[] };
  } catch {
    return { status: "unavailable" };
  }
  const addr = address.toLowerCase();
  // Rank candidate chains by the token's pooled liquidity on each.
  const byChain = new Map<string, any[]>();
  for (const p of json.pairs ?? []) {
    const chain = (p.chainId ?? "").toLowerCase();
    if (!(SUPPORTED_CHAINS as readonly string[]).includes(chain)) continue;
    const onThisPair =
      p.baseToken?.address?.toLowerCase() === addr || p.quoteToken?.address?.toLowerCase() === addr;
    if (!onThisPair) continue;
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(p);
  }
  const liquidityByChain = new Map<string, number>();
  for (const [chain, pairs] of byChain) {
    liquidityByChain.set(chain, comparableLiquidity(pairs, addr));
  }
  if (liquidityByChain.size === 0) return { status: "not_found" };

  // Sort by depth, then by chain name, so two chains with identical liquidity
  // always resolve the same way instead of depending on iteration order.
  const ranked = [...liquidityByChain.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const chain = ranked[0]![0];
  return {
    status: "ok",
    chain: chain as (typeof SUPPORTED_CHAINS)[number],
    ambiguous: ranked.length > 1,
    alternatives: ranked.slice(1).map(([c]) => c),
    // What the choice rested on, so the decision can be stated rather than
    // asserted, and reproduced from the report.
    consideredUsd: Object.fromEntries(ranked),
  };
}

export interface MarketSnapshot {
  provenance?: { url?: string; retrievedAt?: string; responseSha256?: string };
  status: SourceStatus;
  symbol?: string;
  priceUsd?: number;
  /** Pooled liquidity summed across the token's markets on this chain. */
  liquidityUsd?: number;
  /** Liquidity of the single deepest pool — what an exit actually trades against. */
  deepestPoolUsd?: number;
  volume24hUsd?: number;
  txns24h?: number;
  ageDays?: number;
  pairCount?: number;
}

export async function fetchDexScreener(chain: string, address: string): Promise<MarketSnapshot> {
  // One respectful retry on 429; a still-failing source is "unavailable",
  // never silently equated with "no market for this token".
  let json: { pairs?: any[] } | null = null;
  let marketProvenance: MarketSnapshot["provenance"];
  for (let attempt = 0; attempt < 2 && !json; attempt++) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        marketProvenance = {
          url: `https://api.dexscreener.com/latest/dex/tokens/${address}`,
          retrievedAt: new Date().toISOString(),
          responseSha256: createHash("sha256").update(await res.clone().text()).digest("hex"),
        };
      }
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!res.ok) return { status: "unavailable" };
      json = (await res.json()) as { pairs?: any[] };
    } catch {
      return { status: "unavailable" };
    }
  }
  if (!json) return { status: "unavailable" };
  const chainKey = chain.toLowerCase() === "ethereum" ? "ethereum" : chain.toLowerCase();
  const addr = address.toLowerCase();
  // The tokens endpoint returns pairs where the token is on EITHER side.
  // DexScreener's priceUsd/symbol always describe the BASE token, so a pair
  // where our token is the quote must never drive symbol or price directly
  // (querying USDT on bsc otherwise reports whatever token trades against it).
  const pairs = (json.pairs ?? []).filter(
    (p) =>
      (p.chainId ?? "").toLowerCase() === chainKey &&
      (p.baseToken?.address?.toLowerCase() === addr || p.quoteToken?.address?.toLowerCase() === addr),
  );
  if (!pairs.length) return { status: "not_found" };

  const byDepth = (a: any, b: any) => (finiteUsd(a.liquidity?.usd) >= finiteUsd(b.liquidity?.usd) ? a : b);
  const basePairs = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === addr);

  // Aggregate over the token's primary (base-side) markets; quote-side pools
  // are a fallback for tokens that only ever appear as the quote. Risk sizing
  // must under-count liquidity rather than inflate it with exotic pairings.
  const active = basePairs.length ? basePairs : pairs;
  // finiteUsd, not `?? 0`: a string from upstream would concatenate under `+`,
  // turning 0 + "9000" + "2000" into "090002000".
  const liquidityUsd = active.reduce((s, p) => s + finiteUsd(p.liquidity?.usd), 0);
  const volume24hUsd = active.reduce((s, p) => s + finiteUsd(p.volume?.h24), 0);
  const txns24h = active.reduce(
    (s, p) => s + finiteUsd(p.txns?.h24?.buys) + finiteUsd(p.txns?.h24?.sells),
    0,
  );
  const deepest = active.reduce(byDepth);

  let symbol: string | undefined;
  let priceUsd: number | undefined;
  if (basePairs.length) {
    symbol = deepest.baseToken?.symbol;
    priceUsd = Number(deepest.priceUsd) || undefined;
  } else {
    // priceNative = quote units per one base unit, so quoteUsd = baseUsd / priceNative.
    symbol = deepest.quoteToken?.symbol;
    const base = Number(deepest.priceUsd);
    const native = Number(deepest.priceNative);
    priceUsd = Number.isFinite(base) && Number.isFinite(native) && native > 0 ? base / native : undefined;
  }

  return {
    status: "ok",
    provenance: marketProvenance,
    symbol,
    priceUsd,
    liquidityUsd,
    deepestPoolUsd: Math.max(...active.map((p) => p.liquidity?.usd ?? 0), 0) || undefined,
    volume24hUsd,
    txns24h,
    ageDays: deepest.pairCreatedAt ? (Date.now() - deepest.pairCreatedAt) / 86_400_000 : undefined,
    pairCount: active.length,
  };
}
