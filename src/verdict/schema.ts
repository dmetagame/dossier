import { z } from "zod";

// Chains both data sources actually cover. Anything else must 400 (unpaid)
// up front — a paid "abort: no data" report for a typo'd chain name would
// charge the buyer for our silence.
export const SUPPORTED_CHAINS = ["ethereum", "bsc", "base", "arbitrum", "polygon", "xlayer"] as const;

export const ChainName = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(SUPPORTED_CHAINS),
);

export const VerdictRequest = z.object({
  chain: ChainName,
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be an EVM address"),
  action: z.enum(["buy", "sell", "hold", "lp"]).default("buy"),
  // Coerced: a query-string value arrives as a string.
  amountUsd: z.coerce.number().positive().max(10_000_000).optional(),
});
export type VerdictRequest = z.infer<typeof VerdictRequest>;

// The differentiator: not a scanner readout, a decision. Every response gives
// the calling agent a specific action, a sized limit, and a confidence it can
// wire straight into its own control flow.
export interface Verdict {
  verdict: "proceed" | "caution" | "abort";
  maxSizeUsd: number | null;
  confidence: number; // 0..1, driven by data coverage
  reasons: string[]; // ordered, most decisive first
  checks: {
    honeypot: CheckResult;
    contractControl: CheckResult; // mint/owner/proxy/tax powers
    liquidity: CheckResult;
    marketActivity: CheckResult;
    holderConcentration: CheckResult;
  };
  token: {
    chain: string;
    address: string;
    symbol?: string;
    priceUsd?: number;
    liquidityUsd?: number;
    volume24hUsd?: number;
    ageDays?: number;
  };
  meta: {
    sources: string[];
    generatedAt: string;
    latencyMs: number;
  };
}

export interface CheckResult {
  status: "pass" | "warn" | "fail" | "unknown";
  detail: string;
}
