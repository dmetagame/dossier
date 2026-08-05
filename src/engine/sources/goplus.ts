import { createHash } from "node:crypto";
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

// "ok" = data returned; "not_found" = API answered but has no record of the
// token; "unavailable" = API unreachable/throttled — the caller must not
// treat this as knowledge about the token.
export type SourceStatus = "ok" | "not_found" | "unavailable";

/** Provenance, so a signed report can pin what each source actually said. */
export interface Provenance {
  url?: string;
  retrievedAt?: string;
  responseSha256?: string;
}

export interface GoPlusTokenSecurity {
  provenance?: Provenance;
  status: SourceStatus;
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
  /** A lock we could establish, or nothing at all. See the derivation. */
  lpLock?: LpLock;
}

/**
 * A locked-LP finding, kept as one value because its three parts are only true
 * together. "100% locked" and "until 2092" and "by UNCX" answer one question,
 * and a report that carried them as three loose fields would eventually print
 * the share without the expiry — this repository has shipped that exact shape of
 * bug twice.
 */
export interface LpLock {
  /** Share of the main pool's LP that is locked or burned, 0..100. Always > 0. */
  pct: number;
  /**
   * Earliest stated unlock date, `YYYY-MM-DD`, and only when *every* locked
   * position states one. A lock with no expiry is usually a burn address and so
   * permanent, but we do not know that, and mixing a dated tranche with an
   * undated one would let "until 2092" stand for LP that could come out sooner.
   */
  until?: string;
  /** Lockers the source could name, e.g. `["UNCX"]`. Checkable; often empty. */
  via?: string[];
}

/**
 * The LP lock we can establish, or `undefined` when we cannot establish one.
 *
 * LP locking is a positive-only signal, and this is the one place that says so.
 * `is_locked` marks lockers and burn addresses GoPlus recognises, among the top
 * LP holders of a single pool. A zero therefore means "no recognised locker in
 * that sample", which is the default state of almost every real token: WBTC,
 * LINK and PEPE all read 0, and UNI, USDT and CAKE return no `lp_holders` at
 * all. Reporting that zero as a measurement told a buyer that WBTC had "0% of LP
 * locked", and dropped a $790k pool to "liquidity can be pulled" — an absence of
 * evidence dressed as evidence of absence, which is the one thing this service
 * exists to refuse.
 *
 * So a lock is reported when found, and nothing is claimed when not. "None
 * locked" and "no LP holders returned" collapse deliberately: both mean the lock
 * could not be established, and the report already has a way to say that.
 *
 * This is not a substitute for "can one party pull this pool". That needs
 * LP-holder concentration, and this field cannot carry it — GoPlus returns
 * PEPE's own token contract as a 99.88% LP holder.
 *
 * The share is of one pool's LP, not of the token's liquidity: GoPlus returns a
 * single `lp_total_supply`, and `lp_holders` are the holders of that pool's LP
 * token. A token trading across thirty pairs has twenty-nine this says nothing
 * about, so the report calls it the main pool's LP rather than "LP".
 */
export function lpLockOf(lpHolders: unknown): LpLock | undefined {
  interface Holder {
    percent?: string;
    is_locked?: number;
    tag?: string;
    locked_detail?: Array<{ end_time?: string }>;
  }
  const locked = (Array.isArray(lpHolders) ? (lpHolders as Holder[]) : []).filter((h) => h.is_locked === 1);
  const pct = locked.reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100;
  if (!(pct > 0)) return undefined;

  // Every locked position must state an expiry before one is quoted, so a dated
  // tranche can never speak for an undated one sitting beside it.
  const ends = locked.map((h) => h.locked_detail?.map((d) => d.end_time).filter(Boolean).sort()[0]);
  const until = ends.every(Boolean) ? (ends as string[]).sort()[0]!.slice(0, 10) : undefined;

  const via = [...new Set(locked.map((h) => h.tag?.trim()).filter((t): t is string => Boolean(t)))];
  return { pct, ...(until ? { until } : {}), ...(via.length ? { via } : {}) };
}

/** The lock as one sentence fragment, or "" when there is no lock to describe. */
export function describeLock(lock: LpLock | undefined): string {
  if (!lock) return "";
  const until = lock.until ? ` until ${lock.until}` : "";
  const via = lock.via?.length ? ` (${lock.via.join(", ")})` : "";
  return `, ${formatLockedPct(lock.pct)} of the main pool's LP locked${until}${via}`;
}

/**
 * A locked-LP share, rendered so a real lock never reads as no lock.
 *
 * `lpLockedPct` is only ever set when something is genuinely locked, but PEPE's
 * is 0.0091% — a burn address holding a sliver — and rounding that to "0% of LP
 * locked" reproduces, in a report that has a lock, exactly the false sentence
 * that not having one used to produce. Anything below half a percent is shown
 * as "<1%": true, and unmistakably not zero.
 */
export function formatLockedPct(n: number, decimals = 0): string {
  const rounded = Number(n.toFixed(decimals));
  return rounded === 0 ? "<1%" : `${n.toFixed(decimals)}%`;
}

export function goplusSupports(chain: string): boolean {
  return chain.toLowerCase() in CHAIN_IDS;
}

// A blank tax is not a zero tax.
//
// Number("") and Number(" ") are both 0, so a tax GoPlus simply omitted used to
// render as a measured "0%" in a pre-trade risk report, and counted as covered.
// Our own committed fixture carries `"buy_tax": ""`, so this shipped. In a
// product whose whole discipline is that a source which said nothing is never
// treated as evidence, this was the one place that rule was broken.
//
// Anything that is not a finite number in a sane range stays undefined, which
// callers must present as unknown rather than as a measurement.
export function taxPct(v: unknown): number | undefined {
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  const s = String(v).trim();
  if (s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  // GoPlus reports these as a fraction: 0.05 means 5%. Negative is
  // nonsensical, and above 1 is a malformed record rather than a 100%+ tax.
  if (n < 0 || n > 1) return undefined;
  return n * 100;
}

export async function fetchGoPlus(chain: string, address: string): Promise<GoPlusTokenSecurity> {
  const chainId = CHAIN_IDS[chain.toLowerCase()];
  if (!chainId) return { status: "not_found" };
  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`;
  // One respectful retry on 429; a still-failing source is "unavailable",
  // never silently equated with "no data about this token".
  let json: { code?: number; message?: string; result?: Record<string, any> } | null = null;
  let provenance: Provenance = { url };
  for (let attempt = 0; attempt < 2 && !json; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!res.ok) return { status: "unavailable" };
      const body = await res.text();
      // Hash what the source actually said. The provenance in a signed report
      // claimed to pin each source's response, and for GoPlus it carried only a
      // URL: `createHash` was imported here and never used.
      provenance = {
        url,
        retrievedAt: new Date().toISOString(),
        responseSha256: createHash("sha256").update(body).digest("hex"),
      };
      try {
        json = JSON.parse(body) as { code?: number; message?: string; result?: Record<string, any> };
      } catch {
        // A 200 carrying unparseable bytes is an upstream fault, not evidence.
        return { status: "unavailable", provenance };
      }
    } catch {
      return { status: "unavailable" };
    }
  }
  if (!json) return { status: "unavailable", provenance };

  // GoPlus answers application errors with HTTP 200 and a non-success code:
  // rate-limit envelopes, service errors, schema changes. Treating any 200
  // without our token as "no security record" turned an outage into knowledge
  // about the token, which is precisely the tri-state guarantee this engine
  // exists to keep.
  if (json.code !== undefined && json.code !== 1) {
    return { status: "unavailable", provenance };
  }
  if (!json.result || typeof json.result !== "object") {
    // A success code with no result object is malformed, not an empty answer.
    return { status: json.code === 1 ? "not_found" : "unavailable", provenance };
  }
  const entry = json.result[address.toLowerCase()];
  // Only here is "not_found" earned: the API answered successfully, returned a
  // result map, and this token is simply not in it.
  if (!entry) return { status: "not_found", provenance };

  const pct = taxPct;
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

  const lpLock = lpLockOf(entry.lp_holders);

  return {
    status: "ok",
    provenance,
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
    lpLock,
  };
}
