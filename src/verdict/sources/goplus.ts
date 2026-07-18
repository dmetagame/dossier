// GoPlus token security API — free, no key, reachable from the dev box.
// https://docs.gopluslabs.io/reference/tokensecurityusingget_1

const CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  bsc: "56",
  base: "8453",
  arbitrum: "42161",
  polygon: "137",
  xlayer: "196",
};

export interface GoPlusTokenSecurity {
  found: boolean;
  isHoneypot?: boolean;
  cannotSellAll?: boolean;
  buyTaxPct?: number;
  sellTaxPct?: number;
  isMintable?: boolean;
  isProxy?: boolean;
  isOpenSource?: boolean;
  ownerRenounced?: boolean;
  ownerCanChangeBalance?: boolean;
  holderCount?: number;
  topHolderPct?: number; // combined share of top 10 non-LP holders, 0..100
  lpLockedPct?: number;
}

export function goplusSupports(chain: string): boolean {
  return chain.toLowerCase() in CHAIN_IDS;
}

export async function fetchGoPlus(chain: string, address: string): Promise<GoPlusTokenSecurity> {
  const chainId = CHAIN_IDS[chain.toLowerCase()];
  if (!chainId) return { found: false };
  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`;
  // A source outage degrades confidence; it must never fail the paid call.
  let json: { result?: Record<string, any> };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { found: false };
    json = (await res.json()) as { result?: Record<string, any> };
  } catch {
    return { found: false };
  }
  const entry = json.result?.[address.toLowerCase()];
  if (!entry) return { found: false };

  const pct = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n * 100 : undefined;
  };
  const flag = (v: unknown): boolean | undefined => (v === "1" ? true : v === "0" ? false : undefined);

  // Concentration counts wallets only: staking pools, locks, and burn
  // addresses are protocol plumbing, not whales (CAKE's MasterChef holds most
  // supply and is not a dump risk in the whale sense).
  const holders: Array<{ percent?: string; is_contract?: number; tag?: string; address?: string }> =
    entry.holders ?? [];
  const topHolderPct = holders.length
    ? holders
        .filter(
          (h) =>
            h.is_contract !== 1 &&
            !/lock|burn/i.test(h.tag ?? "") &&
            !/^0x0+(dead)?$/i.test(h.address ?? "-"),
        )
        .slice(0, 10)
        .reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100
    : undefined;

  const lpHolders: Array<{ percent?: string; is_locked?: number }> = entry.lp_holders ?? [];
  const lpLockedPct = lpHolders.length
    ? lpHolders.filter((h) => h.is_locked === 1).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100
    : undefined;

  return {
    found: true,
    isHoneypot: flag(entry.is_honeypot),
    cannotSellAll: flag(entry.cannot_sell_all),
    buyTaxPct: pct(entry.buy_tax),
    sellTaxPct: pct(entry.sell_tax),
    isMintable: flag(entry.is_mintable),
    isProxy: flag(entry.is_proxy),
    isOpenSource: flag(entry.is_open_source),
    ownerRenounced:
      entry.owner_address !== undefined
        ? entry.owner_address === "" || /^0x0+(dead)?$/i.test(entry.owner_address)
        : undefined,
    ownerCanChangeBalance: flag(entry.owner_change_balance),
    holderCount: entry.holder_count ? Number(entry.holder_count) : undefined,
    topHolderPct,
    lpLockedPct,
  };
}
