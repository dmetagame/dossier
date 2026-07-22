import { z } from "zod";
import { fetchGoPlus, goplusSupports } from "../verdict/sources/goplus";
import { fetchDexScreener, resolveChain } from "../verdict/sources/dexscreener";
import { evaluate, SourcesUnavailableError } from "../verdict/engine";
import { ChainName, SUPPORTED_CHAINS } from "../verdict/schema";

export { SourcesUnavailableError };

// Chain omitted and the address trades on more than one supported chain:
// the buyer must disambiguate — same address, different contracts.
export class ChainAmbiguousError extends Error {
  constructor(public candidates: string[]) {
    super(`token trades on multiple chains: ${candidates.join(", ")} — specify "chain"`);
    this.name = "ChainAmbiguousError";
  }
}

// Chain omitted and no supported chain has a market for the address.
export class ChainNotFoundError extends Error {
  constructor() {
    super(`no market found for this address on any supported chain (${SUPPORTED_CHAINS.join(", ")})`);
    this.name = "ChainNotFoundError";
  }
}

// Dossier: one request -> a polished, shareable due-diligence report on a token,
// assembled deterministically from live on-chain data. The deliverable is a
// self-contained HTML document (prints cleanly to PDF) plus the structured data
// behind it, so an agent gets both a human-ready asset and machine-readable fields.

export const DossierRequest = z.object({
  // Optional: omitted means "auto-detect", resolved only when unambiguous.
  chain: ChainName.optional(),
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be an EVM address"),
  format: z.enum(["html", "json"]).default("html"),
});
export type DossierRequest = z.infer<typeof DossierRequest>;

export interface Dossier {
  title: string;
  generatedAt: string;
  token: {
    chain: string;
    address: string;
    symbol?: string;
    priceUsd?: number;
    liquidityUsd?: number;
    volume24hUsd?: number;
    ageDays?: number;
    holderCount?: number;
  };
  riskVerdict: Awaited<ReturnType<typeof evaluate>>;
  security: {
    openSource?: boolean;
    proxy?: boolean;
    mintable?: boolean;
    ownerRenounced?: boolean;
    buyTaxPct?: number;
    sellTaxPct?: number;
    lpLockedPct?: number;
    topHolderPct?: number;
  };
  sources: string[];
}

export async function buildDossier(req: DossierRequest): Promise<Dossier> {
  let chain = req.chain;
  if (!chain) {
    const resolved = await resolveChain(req.tokenAddress);
    if (resolved.status === "ambiguous") throw new ChainAmbiguousError(resolved.candidates);
    if (resolved.status === "not_found") throw new ChainNotFoundError();
    if (resolved.status === "unavailable") throw new SourcesUnavailableError();
    chain = resolved.chain;
  }

  const [sec, market, verdict] = await Promise.all([
    goplusSupports(chain)
      ? fetchGoPlus(chain, req.tokenAddress)
      : Promise.resolve({ status: "not_found" } as const),
    fetchDexScreener(chain, req.tokenAddress),
    evaluate({ chain, tokenAddress: req.tokenAddress, action: "buy" }),
  ]);

  if (sec.status === "unavailable" && market.status === "unavailable") {
    throw new SourcesUnavailableError();
  }

  const sources: string[] = [];
  if (sec.status === "ok") sources.push("GoPlus");
  if (market.status === "ok") sources.push("DexScreener");

  return {
    title: `Due-Diligence Dossier — ${market.status === "ok" && market.symbol ? market.symbol : req.tokenAddress.slice(0, 8)}`,
    generatedAt: new Date().toISOString(),
    token: {
      chain,
      address: req.tokenAddress,
      symbol: market.status === "ok" ? market.symbol : undefined,
      priceUsd: market.status === "ok" ? market.priceUsd : undefined,
      liquidityUsd: market.status === "ok" ? market.liquidityUsd : undefined,
      volume24hUsd: market.status === "ok" ? market.volume24hUsd : undefined,
      ageDays: market.status === "ok" && market.ageDays ? Number(market.ageDays.toFixed(1)) : undefined,
      holderCount: sec.status === "ok" ? sec.holderCount : undefined,
    },
    riskVerdict: verdict,
    security: {
      openSource: sec.status === "ok" ? sec.isOpenSource : undefined,
      proxy: sec.status === "ok" ? sec.isProxy : undefined,
      mintable: sec.status === "ok" ? sec.isMintable : undefined,
      ownerRenounced: sec.status === "ok" ? sec.ownerRenounced : undefined,
      buyTaxPct: sec.status === "ok" ? sec.buyTaxPct : undefined,
      sellTaxPct: sec.status === "ok" ? sec.sellTaxPct : undefined,
      lpLockedPct: sec.status === "ok" ? sec.lpLockedPct : undefined,
      topHolderPct: sec.status === "ok" ? sec.topHolderPct : undefined,
    },
    sources,
  };
}
