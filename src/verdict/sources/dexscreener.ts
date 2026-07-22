// DexScreener pairs API — free, no key, reachable from the dev box.
// Gives liquidity depth, volume, price, and pair age across chains incl. X Layer.

import type { SourceStatus } from "./goplus";

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

  const byDepth = (a: any, b: any) => ((a.liquidity?.usd ?? 0) >= (b.liquidity?.usd ?? 0) ? a : b);
  const basePairs = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === addr);

  // Aggregate over the token's primary (base-side) markets; quote-side pools
  // are a fallback for tokens that only ever appear as the quote. Risk sizing
  // must under-count liquidity rather than inflate it with exotic pairings.
  const active = basePairs.length ? basePairs : pairs;
  const liquidityUsd = active.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const volume24hUsd = active.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
  const txns24h = active.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0), 0);
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
    symbol,
    priceUsd,
    liquidityUsd,
    volume24hUsd,
    txns24h,
    ageDays: deepest.pairCreatedAt ? (Date.now() - deepest.pairCreatedAt) / 86_400_000 : undefined,
    pairCount: active.length,
  };
}
