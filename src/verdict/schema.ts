import { z } from "zod";

export const VerdictRequest = z.object({
  chain: z.string().min(1),
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be an EVM address"),
  action: z.enum(["buy", "sell", "hold", "lp"]).default("buy"),
  amountUsd: z.number().positive().max(10_000_000).optional(),
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
