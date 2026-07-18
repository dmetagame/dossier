// DexScreener pairs API — free, no key, reachable from the dev box.
// Gives liquidity depth, volume, price, and pair age across chains incl. X Layer.

export interface MarketSnapshot {
  found: boolean;
  symbol?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  txns24h?: number;
  ageDays?: number;
  pairCount?: number;
}

export async function fetchDexScreener(chain: string, address: string): Promise<MarketSnapshot> {
  // A source outage degrades confidence; it must never fail the paid call.
  let json: { pairs?: any[] };
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { found: false };
    json = (await res.json()) as { pairs?: any[] };
  } catch {
    return { found: false };
  }
  const chainKey = chain.toLowerCase() === "ethereum" ? "ethereum" : chain.toLowerCase();
  const pairs = (json.pairs ?? []).filter((p) => (p.chainId ?? "").toLowerCase() === chainKey);
  if (!pairs.length) return { found: false };

  // Aggregate across pairs; deepest pair drives price and age.
  const deepest = pairs.reduce((a, b) => ((a.liquidity?.usd ?? 0) >= (b.liquidity?.usd ?? 0) ? a : b));
  const liquidityUsd = pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const volume24hUsd = pairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
  const txns24h = pairs.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0), 0);

  return {
    found: true,
    symbol: deepest.baseToken?.symbol,
    priceUsd: Number(deepest.priceUsd) || undefined,
    liquidityUsd,
    volume24hUsd,
    txns24h,
    ageDays: deepest.pairCreatedAt ? (Date.now() - deepest.pairCreatedAt) / 86_400_000 : undefined,
    pairCount: pairs.length,
  };
}
