import type { Verdict, RiskRequest, CheckResult } from "./schema";
import { fetchGoPlus, formatLockedPct, goplusSupports } from "./sources/goplus";
import { fetchDexScreener, type TokenPairs } from "./sources/dexscreener";
import { fetchChainFacts, rpcSupports, type RpcSnapshot } from "./sources/rpc";

// Thrown when no data source could be reached at all — the caller must
// surface a 503 so the agent retries, never a charged verdict built on air.
export class SourcesUnavailableError extends Error {
  constructor() {
    super("all data sources unavailable");
    this.name = "SourcesUnavailableError";
  }
}

// v0 engine: deterministic factor scoring over live GoPlus + DexScreener data.
// Design rule: every response is a decision an agent can act on directly —
// action, sized limit, confidence — never a raw flag dump. An LLM synthesis
// layer can later sharpen `reasons`, but the verdict itself stays rule-driven
// so it is reproducible and benchmarkable against known-rug / known-legit sets.

/**
 * One round of source fetching, shared by everything that needs it.
 *
 * Exported so a caller that also needs the raw source data — the report
 * builder, which prints the contract and distribution figures — can fetch once
 * and hand the same snapshot to `evaluate`. Fetching twice meant the report's
 * view and the verdict's view were independent: when one call succeeded and the
 * other was rate-limited, a single document claimed GoPlus as a source while
 * its own risk checks read "no security data". It also doubled our load on the
 * free APIs that produce the rate-limiting in the first place.
 */
export interface SourceSnapshot {
  sec: Awaited<ReturnType<typeof fetchGoPlus>>;
  market: Awaited<ReturnType<typeof fetchDexScreener>>;
  /** Direct chain reads: what the contract itself says about itself. */
  chain: RpcSnapshot;
  /** When fetching began, so a caller's latency figure stays honest. */
  startedAt: number;
}

export async function fetchSources(
  chain: string,
  tokenAddress: string,
  /** The caller's single DexScreener observation, so the whole report describes one. */
  sharedPairs?: TokenPairs,
): Promise<SourceSnapshot> {
  const startedAt = Date.now();
  const [sec, market, chainFacts] = await Promise.all([
    goplusSupports(chain) ? fetchGoPlus(chain, tokenAddress) : Promise.resolve({ status: "not_found" } as const),
    fetchDexScreener(chain, tokenAddress, sharedPairs, startedAt),
    rpcSupports(chain)
      ? fetchChainFacts(chain, tokenAddress)
      : Promise.resolve({ status: "unavailable" } as const),
  ]);
  return { sec, market, chain: chainFacts, startedAt };
}

export async function evaluate(req: RiskRequest, prefetched?: SourceSnapshot): Promise<Verdict> {
  const snapshot = prefetched ?? (await fetchSources(req.chain, req.tokenAddress));
  const { sec, market, chain: chainFacts } = snapshot;
  const started = snapshot.startedAt;
  const sources: string[] = [];

  if (sec.status === "ok") sources.push("goplus");
  if (market.status === "ok") sources.push("dexscreener");
  if (chainFacts.status === "ok") sources.push("rpc");

  // Outage and obscurity are different facts: if nothing answered, we know
  // nothing about the token and must not pretend otherwise. The chain is not
  // counted here: it can describe a contract but never a market, so an
  // RPC-only answer is not enough to price a position on.
  if (sec.status === "unavailable" && market.status === "unavailable") {
    throw new SourcesUnavailableError();
  }

  const checks = {
    honeypot: honeypotCheck(sec),
    contractControl: controlCheck(sec, chainFacts),
    liquidity: liquidityCheck(market.status === "ok" ? market : undefined, sec),
    marketActivity: activityCheck(market.status === "ok" ? market : undefined),
    holderConcentration: concentrationCheck(sec),
  };

  const failed = Object.values(checks).filter((c) => c.status === "fail");
  const warned = Object.values(checks).filter((c) => c.status === "warn");
  const unknown = Object.values(checks).filter((c) => c.status === "unknown");

  // Confidence = data coverage, not conviction. All five known → 1.0.
  const confidence = Number(((5 - unknown.length) / 5).toFixed(2));

  // Sources that *answered* "never heard of it" mean there is no market and
  // no security record — for an agent about to spend, that is an abort.
  const trulyUnknownToken = sec.status === "not_found" && market.status === "not_found";

  let verdict: Verdict["verdict"];
  if (failed.length > 0) verdict = "abort";
  else if (trulyUnknownToken) verdict = "abort";
  else if (warned.length >= 1 || unknown.length > 0) verdict = "caution";
  else verdict = "proceed";
  // A clean sheet with full coverage is the only "proceed".

  // Size cap: never more than 1% of the liquidity an exit actually trades
  // against, halved when cautioned; null when aborting or unknown.
  //
  // That means the deepest single pool, not the sum of every pool. Summing is
  // what a token's marketing page does; a seller hits one venue. On a token
  // split across thirty pools the aggregate figure was suggesting roughly four
  // times what the deepest pool could absorb — an overstatement in the one
  // direction that costs the buyer money.
  let maxSizeUsd: number | null = null;
  const exitLiquidity =
    market.status === "ok" ? (market.deepestPoolUsd ?? market.liquidityUsd) : undefined;
  if (verdict !== "abort" && exitLiquidity) {
    maxSizeUsd = Math.floor(exitLiquidity * 0.01);
    if (verdict === "caution") maxSizeUsd = Math.floor(maxSizeUsd / 2);
    if (req.amountUsd && req.amountUsd < maxSizeUsd) maxSizeUsd = req.amountUsd;
  }

  const reasons: string[] = [
    ...(trulyUnknownToken
      ? ["No security record and no market found for this token on this chain — treat as untradeable."]
      : []),
    ...failed.map((c) => c.detail),
    ...warned.map((c) => c.detail),
    ...(verdict === "proceed" ? ["All five checks passed on live data."] : []),
    ...(unknown.length ? [`No data for: ${unknown.map((c) => c.detail).join("; ")}`] : []),
  ];
  if (req.amountUsd && maxSizeUsd !== null && req.amountUsd > maxSizeUsd) {
    reasons.push(
      `Requested $${req.amountUsd} exceeds the heuristic size cap for current liquidity — capped at $${maxSizeUsd}.`,
    );
  }

  return {
    verdict,
    maxSizeUsd,
    confidence,
    reasons,
    checks,
    token: {
      chain: req.chain,
      address: req.tokenAddress,
      symbol: market.status === "ok" ? market.symbol : undefined,
      priceUsd: market.status === "ok" ? market.priceUsd : undefined,
      liquidityUsd: market.status === "ok" ? market.liquidityUsd : undefined,
      deepestPoolUsd: market.status === "ok" ? market.deepestPoolUsd : undefined,
      volume24hUsd: market.status === "ok" ? market.volume24hUsd : undefined,
      ageDays: market.status === "ok" && market.ageDays ? Number(market.ageDays.toFixed(1)) : undefined,
    },
    meta: { sources, generatedAt: new Date().toISOString(), latencyMs: Date.now() - started },
  };
}

type Sec = Awaited<ReturnType<typeof fetchGoPlus>>;
type Market = Awaited<ReturnType<typeof fetchDexScreener>>;

export function honeypotCheck(sec: Sec): CheckResult {
  if (sec.status !== "ok") return { status: "unknown", detail: "sellability (no security data)" };
  if (sec.isHoneypot) return { status: "fail", detail: "Flagged as a honeypot — buyers cannot sell." };
  if (sec.cannotSellAll) return { status: "fail", detail: "Contract restricts selling full balances." };
  // Absent tax figures are not the same as zero tax. The source omits them for
  // many tokens, and reporting a clean pass on that silence would be claiming
  // knowledge we do not have — the mistake this engine exists to avoid.
  // Each side is judged on its own evidence. Requiring only *one* of them to be
  // present and defaulting the other to zero meant a token with a known 0% buy
  // tax and an unreported sell tax could pass as "sell 0%" while a punitive exit
  // had never been ruled out. Sell tax is the one that traps a buyer, so it is
  // the one that must never be assumed.
  const buy = sec.buyTaxPct;
  const sell = sec.sellTaxPct;

  // A known-bad sell tax settles it whatever else is missing.
  if (sell !== undefined && sell > 15) {
    return { status: "fail", detail: `Sell tax ${sell.toFixed(0)}% — exit is punitive.` };
  }
  if (sell === undefined) {
    return {
      status: "warn",
      detail:
        buy === undefined
          ? "No honeypot flag, but the security source reported neither trading tax — a sell tax cannot be ruled out."
          : `No honeypot flag and buy tax is ${buy}%, but the sell tax was not reported — a punitive exit cannot be ruled out.`,
    };
  }
  if (buy === undefined) {
    return { status: "warn", detail: `Sell tax is ${sell}%, but the buy tax was not reported.` };
  }
  if (sell > 5 || buy > 5) {
    return { status: "warn", detail: `Trading taxes present (buy ${buy}%, sell ${sell}%).` };
  }
  return { status: "pass", detail: `No honeypot flags; buy ${buy}% / sell ${sell}% tax.` };
}

export function controlCheck(sec: Sec, chain: RpcSnapshot): CheckResult {
  // Evidence from both sources is merged, and a risk seen by either one survives.
  //
  // This used to hand the whole question to the chain only when GoPlus had
  // nothing at all: `if (sec.status !== "ok") return controlFromChain(chain)`.
  // A sparse but "ok" GoPlus record therefore silenced the chain entirely, and
  // every field GoPlus omitted read as "no risk". A report could print an
  // EIP-1967 implementation slot and mint or pause selectors found in the
  // deployed bytecode, while the scored check beside it said "No dangerous owner
  // powers detected" — the report contradicting itself, in the direction that
  // flatters the token.
  //
  // Absent is not false. A missing GoPlus field contributes nothing either way;
  // only a positive signal counts, from whichever source saw it.
  if (sec.status !== "ok") return controlFromChain(chain);

  // The strongest single finding either source can make.
  if (sec.ownerCanChangeBalance) {
    return { status: "fail", detail: "Owner can modify holder balances." };
  }

  const powers: string[] = [];
  const fromChain = chain.status === "ok";

  // Proxy: believe either source. GoPlus omitting the flag is not a denial, and
  // an implementation slot read directly from the chain is primary evidence.
  const proxyOnChain = fromChain && Boolean(chain.proxyImplementation);
  if (sec.isProxy || proxyOnChain) {
    powers.push(
      sec.isProxy === undefined && proxyOnChain
        ? "upgradeable proxy (implementation slot read from the chain)"
        : "upgradeable proxy",
    );
  }

  // Mintable, from the aggregator's flag or from a mint selector in the
  // bytecode. Either way it only counts while an owner remains.
  const ownerActive = sec.ownerRenounced === false || (fromChain && chain.ownerRenounced === false);
  const mintOnChain = fromChain && Boolean(chain.capabilities?.includes("mint"));
  if ((sec.isMintable || mintOnChain) && ownerActive) {
    powers.push(mintOnChain && !sec.isMintable ? "mint function present, owner not renounced" : "mintable by active owner");
  }

  // Powers GoPlus does not report at all. Before this merge they were visible in
  // the report and absent from the score.
  if (fromChain && chain.capabilities?.includes("pause")) powers.push("pausable");
  if (fromChain && chain.capabilities?.includes("blacklist")) powers.push("address blacklisting");

  if (sec.isOpenSource === false) powers.push("unverified source");

  if (powers.length >= 2) return { status: "fail", detail: `Contract control risks: ${powers.join(", ")}.` };
  if (powers.length === 1) return { status: "warn", detail: `Contract control risk: ${powers[0]}.` };

  // Nothing found. Say which evidence that rests on, so a clean result on a
  // half-empty record is not read as a clean result on a full one.
  return {
    status: "pass",
    detail: fromChain
      ? "No dangerous owner powers detected, in the security record or the deployed bytecode."
      : "No dangerous owner powers detected in the security record; the chain could not be read.",
  };
}

/**
 * Contract control read straight off the chain.
 *
 * Weaker than the security source, and labelled as such: an EIP-1967
 * implementation slot proves upgradeability, but capabilities come from
 * scanning the dispatch table for selectors, which is evidence rather than
 * proof. It is still far better than "no data".
 */
function controlFromChain(chain: RpcSnapshot): CheckResult {
  if (chain.status !== "ok") {
    return { status: "unknown", detail: "contract control (no security data)" };
  }
  if (!chain.isContract) {
    return { status: "fail", detail: "No contract code at this address on this chain." };
  }
  const powers: string[] = [];
  if (chain.proxyImplementation) powers.push("upgradeable proxy");
  if (chain.capabilities?.includes("mint") && chain.ownerRenounced === false) {
    powers.push("mint function present, owner not renounced");
  }
  if (chain.capabilities?.includes("pause")) powers.push("pausable");
  if (chain.capabilities?.includes("blacklist")) powers.push("address blacklisting");
  const note = " (read from the chain; the security source had no record)";
  if (powers.length >= 2) return { status: "fail", detail: `Contract control risks: ${powers.join(", ")}${note}.` };
  if (powers.length === 1) return { status: "warn", detail: `Contract control risk: ${powers[0]}${note}.` };
  return { status: "pass", detail: `No upgrade, pause or blacklist powers found in the deployed bytecode${note}.` };
}

export function liquidityCheck(market: Market | undefined, sec: Sec): CheckResult {
  if (market?.status !== "ok" || market.liquidityUsd === undefined)
    return { status: "unknown", detail: "liquidity (no market data)" };
  // A found lock is worth mentioning. Not finding one is not a finding, so it
  // adds nothing to the sentence and cannot move the verdict — see the
  // derivation of `lpLockedPct` in sources/goplus.ts for why the absence carries
  // no information.
  const lockNote =
    sec.status === "ok" && sec.lpLockedPct !== undefined
      ? `, ${formatLockedPct(sec.lpLockedPct)} of LP locked`
      : "";
  if (market.liquidityUsd < 10_000)
    return { status: "fail", detail: `Pooled liquidity $${Math.round(market.liquidityUsd)} — too thin to exit${lockNote}.` };
  if (market.liquidityUsd < 100_000)
    return { status: "warn", detail: `Pooled liquidity $${Math.round(market.liquidityUsd)} — shallow${lockNote}.` };
  // There used to be a warn here for pools under $1M with under 20% of LP
  // locked, meant to catch a deployer who could pull the pool. Because an
  // unestablished lock read as 0%, it fired on essentially every token in that
  // band regardless of who held the LP, and it is the reason a bridged blue chip
  // came back "caution — liquidity can be pulled" with a $1.1k size cap. The
  // question it asked is a good one; this data cannot answer it, and a check
  // that fires on everything answers nothing.
  return { status: "pass", detail: `Pooled liquidity $${Math.round(market.liquidityUsd)}${lockNote}.` };
}

export function activityCheck(market: Market | undefined): CheckResult {
  if (market?.status !== "ok") return { status: "unknown", detail: "market activity (no market data)" };
  if ((market.ageDays ?? Infinity) < 3)
    return { status: "warn", detail: `Pair is ${market.ageDays?.toFixed(1)} days old — no track record.` };
  // Absent volume cannot pass this check and cannot fail it. Defaulting it to
  // zero declared a near-dead market on a source's silence, and the check was
  // counted as covered either way.
  if (market.volume24hUsd === undefined) {
    return {
      status: "unknown",
      detail: "market activity (the market source did not report 24h volume)",
    };
  }
  if (market.volume24hUsd < 1_000)
    return { status: "warn", detail: `24h volume $${Math.round(market.volume24hUsd)} — near-dead market.` };
  return {
    status: "pass",
    detail: `24h volume $${Math.round(market.volume24hUsd)} across ${market.pairCount} pair(s).`,
  };
}

function concentrationCheck(sec: Sec): CheckResult {
  if (sec.status !== "ok" || sec.topHolderPct === undefined)
    return { status: "unknown", detail: "holder concentration (no holder data)" };
  if (sec.topHolderPct > 60)
    return { status: "fail", detail: `Top 10 holders control ${sec.topHolderPct.toFixed(0)}% of supply.` };
  if (sec.topHolderPct > 30)
    return { status: "warn", detail: `Top 10 holders hold ${sec.topHolderPct.toFixed(0)}% of supply.` };
  return { status: "pass", detail: `Top 10 holders hold ${sec.topHolderPct.toFixed(0)}% of supply.` };
}
