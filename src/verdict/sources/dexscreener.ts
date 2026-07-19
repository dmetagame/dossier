// DexScreener pairs API — free, no key, reachable from the dev box.
// Gives liquidity depth, volume, price, and pair age across chains incl. X Layer.

import type { SourceStatus } from "./goplus.js";

export interface MarketSnapshot {
  status: SourceStatus;
  symbol?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  txns24h?: number;
  ageDays?: number;
  pairCount?: number;
}

export async function fetchDexScreener(chain: string, address: string): Promise<MarketSnapshot> {
  // One respectful retry on 429; a still-failing source is "unavailable",
  // never silently equated with "no market for this token".
  let json: { pairs?: any[] } | null = null;
  for (let attempt = 0; attempt < 2 && !json; attempt++) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        signal: AbortSignal.timeout(8000),
      });
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
  const pairs = (json.pairs ?? []).filter((p) => (p.chainId ?? "").toLowerCase() === chainKey);
  if (!pairs.length) return { status: "not_found" };

  // Aggregate across pairs; deepest pair drives price and age.
  const deepest = pairs.reduce((a, b) => ((a.liquidity?.usd ?? 0) >= (b.liquidity?.usd ?? 0) ? a : b));
  const liquidityUsd = pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const volume24hUsd = pairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
  const txns24h = pairs.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0), 0);

  return {
    status: "ok",
    symbol: deepest.baseToken?.symbol,
    priceUsd: Number(deepest.priceUsd) || undefined,
    liquidityUsd,
    volume24hUsd,
    txns24h,
    ageDays: deepest.pairCreatedAt ? (Date.now() - deepest.pairCreatedAt) / 86_400_000 : undefined,
    pairCount: pairs.length,
  };
}
