import type { Verdict, VerdictRequest, CheckResult } from "./schema";
import { fetchGoPlus, goplusSupports } from "./sources/goplus";
import { fetchDexScreener } from "./sources/dexscreener";

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

export async function evaluate(req: VerdictRequest): Promise<Verdict> {
  const started = Date.now();
  const sources: string[] = [];

  const [sec, market] = await Promise.all([
    goplusSupports(req.chain) ? fetchGoPlus(req.chain, req.tokenAddress) : Promise.resolve({ status: "not_found" } as const),
    fetchDexScreener(req.chain, req.tokenAddress),
  ]);
  if (sec.status === "ok") sources.push("goplus");
  if (market.status === "ok") sources.push("dexscreener");

  // Outage and obscurity are different facts: if nothing answered, we know
  // nothing about the token and must not pretend otherwise.
  if (sec.status === "unavailable" && market.status === "unavailable") {
    throw new SourcesUnavailableError();
  }

  const checks = {
    honeypot: honeypotCheck(sec),
    contractControl: controlCheck(sec),
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

  // Size cap: never more than 1% of pooled liquidity for a buy, halved when
  // cautioned; null when aborting or when liquidity is unknown.
  let maxSizeUsd: number | null = null;
  if (verdict !== "abort" && market.status === "ok" && market.liquidityUsd) {
    maxSizeUsd = Math.floor(market.liquidityUsd * 0.01);
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
      `Requested $${req.amountUsd} exceeds the safe size for current liquidity — capped at $${maxSizeUsd}.`,
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
      volume24hUsd: market.status === "ok" ? market.volume24hUsd : undefined,
      ageDays: market.status === "ok" && market.ageDays ? Number(market.ageDays.toFixed(1)) : undefined,
    },
    meta: { sources, generatedAt: new Date().toISOString(), latencyMs: Date.now() - started },
  };
}

type Sec = Awaited<ReturnType<typeof fetchGoPlus>>;
type Market = Awaited<ReturnType<typeof fetchDexScreener>>;

function honeypotCheck(sec: Sec): CheckResult {
  if (sec.status !== "ok") return { status: "unknown", detail: "sellability (no security data)" };
  if (sec.isHoneypot) return { status: "fail", detail: "Flagged as a honeypot — buyers cannot sell." };
  if (sec.cannotSellAll) return { status: "fail", detail: "Contract restricts selling full balances." };
  if ((sec.sellTaxPct ?? 0) > 15)
    return { status: "fail", detail: `Sell tax ${sec.sellTaxPct?.toFixed(0)}% — exit is punitive.` };
  if ((sec.sellTaxPct ?? 0) > 5 || (sec.buyTaxPct ?? 0) > 5)
    return { status: "warn", detail: `Trading taxes present (buy ${sec.buyTaxPct ?? 0}%, sell ${sec.sellTaxPct ?? 0}%).` };
  return { status: "pass", detail: "Sellable, no honeypot indicators." };
}

function controlCheck(sec: Sec): CheckResult {
  if (sec.status !== "ok") return { status: "unknown", detail: "contract control (no security data)" };
  if (sec.ownerCanChangeBalance)
    return { status: "fail", detail: "Owner can modify holder balances." };
  const powers: string[] = [];
  if (sec.isMintable && sec.ownerRenounced === false) powers.push("mintable by active owner");
  if (sec.isProxy) powers.push("upgradeable proxy");
  if (sec.isOpenSource === false) powers.push("unverified source");
  if (powers.length >= 2) return { status: "fail", detail: `Contract control risks: ${powers.join(", ")}.` };
  if (powers.length === 1) return { status: "warn", detail: `Contract control risk: ${powers[0]}.` };
  return { status: "pass", detail: "No dangerous owner powers detected." };
}

function liquidityCheck(market: Market | undefined, sec: Sec): CheckResult {
  if (market?.status !== "ok" || market.liquidityUsd === undefined)
    return { status: "unknown", detail: "liquidity (no market data)" };
  const lockNote =
    sec.status === "ok" && sec.lpLockedPct !== undefined ? `, ${sec.lpLockedPct.toFixed(0)}% of LP locked` : "";
  if (market.liquidityUsd < 10_000)
    return { status: "fail", detail: `Pooled liquidity $${Math.round(market.liquidityUsd)} — too thin to exit${lockNote}.` };
  if (market.liquidityUsd < 100_000)
    return { status: "warn", detail: `Pooled liquidity $${Math.round(market.liquidityUsd)} — shallow${lockNote}.` };
  // LP locking matters when a single deployer could pull the pool; deep
  // markets ($1M+) don't work that way and locking isn't practiced there.
  if (market.liquidityUsd < 1_000_000 && sec.status === "ok" && sec.lpLockedPct !== undefined && sec.lpLockedPct < 20)
    return { status: "warn", detail: `Only ${sec.lpLockedPct.toFixed(0)}% of LP locked — liquidity can be pulled.` };
  return { status: "pass", detail: `Pooled liquidity $${Math.round(market.liquidityUsd)}${lockNote}.` };
}

function activityCheck(market: Market | undefined): CheckResult {
  if (market?.status !== "ok") return { status: "unknown", detail: "market activity (no market data)" };
  if ((market.ageDays ?? Infinity) < 3)
    return { status: "warn", detail: `Pair is ${market.ageDays?.toFixed(1)} days old — no track record.` };
  if ((market.volume24hUsd ?? 0) < 1_000)
    return { status: "warn", detail: `24h volume $${Math.round(market.volume24hUsd ?? 0)} — near-dead market.` };
  return {
    status: "pass",
    detail: `24h volume $${Math.round(market.volume24hUsd ?? 0)} across ${market.pairCount} pair(s).`,
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
