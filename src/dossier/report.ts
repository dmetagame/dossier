import { z } from "zod";
import { resolveChain } from "../engine/sources/dexscreener";
import { evaluate, fetchSources, SourcesUnavailableError } from "../engine/engine";
import { ChainName, SUPPORTED_CHAINS } from "../engine/schema";
import {
  attest,
  canonicalJson,
  sha256,
  METHODOLOGY_VERSION,
  SCHEMA_VERSION,
  type Attestation,
  type SourceObservation,
} from "../attest";
import { config } from "../config";
import { randomUUID } from "node:crypto";

export { SourcesUnavailableError };

// How the chain was determined, so the buyer can always tell whether they
// specified it, we inferred it, or we picked between several deployments.
export interface ChainResolutionInfo {
  source: "specified" | "auto-detected";
  ambiguous: boolean;
  alternatives: string[];
}

// Chain omitted and no supported chain has a market for the address.
export class ChainNotFoundError extends Error {
  constructor() {
    super(`no market found for this address on any supported chain (${SUPPORTED_CHAINS.join(", ")})`);
    this.name = "ChainNotFoundError";
  }
}

/**
 * Both sources answered, and neither has ever heard of this address.
 *
 * There is no report to write: no security record, no market, nothing to check.
 * Returning an aborted report at 200 would settle the payment and charge for the
 * sentence "we found nothing", which is not what the listing sells. A non-2xx
 * cannot settle, so the buyer keeps their money.
 */
/** No code at the address: a wallet, or a contract that was never deployed. */
export class NotAContractError extends Error {
  constructor(readonly chain: string, readonly address: string) {
    super(`no contract code at ${address} on ${chain}`);
    this.name = "NotAContractError";
  }
}

export class TokenNotFoundError extends Error {
  constructor(readonly chain: string, readonly address: string) {
    super(`no security record and no market found for ${address} on ${chain}`);
    this.name = "TokenNotFoundError";
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

export interface Preflight {
  token: { address: string; chain: string; symbol?: string };
  sources: { goplus: string; dexscreener: string; rpc: string };
  expectedCoverage: number;
  fieldsAvailable: string[];
  fieldsUnavailable: string[];
  reportAvailable: boolean;
  note: string;
}

/**
 * What a buyer would get, before they pay for it.
 *
 * Deliberately withholds the answer: coverage and field availability only, never
 * the verdict, the reasons, the size cap, or any security flag. It tells you
 * whether the report is worth buying, not what it says — otherwise the free
 * endpoint would replace the paid one.
 */
export async function preflight(req: DossierRequest): Promise<Preflight> {
  let chain = req.chain as z.infer<typeof ChainName>;
  if (!chain) {
    const resolved = await resolveChain(req.tokenAddress);
    if (resolved.status === "not_found") throw new ChainNotFoundError();
    if (resolved.status === "unavailable") throw new SourcesUnavailableError();
    chain = resolved.chain;
  }
  const snapshot = await fetchSources(chain, req.tokenAddress);
  const { sec, market, chain: chainFacts } = snapshot;
  if (sec.status === "unavailable" && market.status === "unavailable") {
    throw new SourcesUnavailableError();
  }

  // Coverage is computed by the engine that will write the report, so this can
  // never promise a number the paid deliverable then contradicts.
  const verdict = await evaluate({ chain, tokenAddress: req.tokenAddress, action: "buy" }, snapshot);
  const known = (v: unknown) => v !== undefined && v !== null;
  const fields: Record<string, boolean> = {
    priceUsd: market.status === "ok" && known(market.priceUsd),
    liquidityUsd: market.status === "ok" && known(market.liquidityUsd),
    deepestPoolUsd: market.status === "ok" && known(market.deepestPoolUsd),
    volume24hUsd: market.status === "ok" && known(market.volume24hUsd),
    ageDays: market.status === "ok" && known(market.ageDays),
    holderCount: sec.status === "ok" && known(sec.holderCount),
    topHolderPct: sec.status === "ok" && known(sec.topHolderPct),
    taxes: sec.status === "ok" && (known(sec.buyTaxPct) || known(sec.sellTaxPct)),
    contractControl: sec.status === "ok" || chainFacts.status === "ok",
    contractIdentity: chainFacts.status === "ok" && chainFacts.isContract,
    heuristicSizeCap: verdict.maxSizeUsd !== null,
  };
  // No code at the address is a different, sharper answer than "no market".
  const noContract = chainFacts.status === "ok" && !chainFacts.isContract;
  const reportAvailable =
    !noContract && !(sec.status === "not_found" && market.status === "not_found");
  return {
    token: {
      address: req.tokenAddress,
      chain,
      symbol:
        (market.status === "ok" ? market.symbol : undefined) ??
        (chainFacts.status === "ok" ? chainFacts.symbol : undefined),
    },
    sources: { goplus: sec.status, dexscreener: market.status, rpc: chainFacts.status },
    expectedCoverage: verdict.confidence,
    fieldsAvailable: Object.keys(fields).filter((k) => fields[k]),
    fieldsUnavailable: Object.keys(fields).filter((k) => !fields[k]),
    reportAvailable,
    note: noContract
      ? "There is no contract code at this address on this chain. The paid endpoint will refuse it and take no payment."
      : !reportAvailable
      ? "Neither source has a record of this token. The paid endpoint will refuse it and take no payment."
      : verdict.confidence < 1
        ? "Partial coverage. The report will state every unavailable field rather than estimate it."
        : "Full coverage across all five checks.",
  };
}

export interface ContractFacts {
  isContract: boolean;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: number;
  proxyImplementation?: string;
  proxyAdmin?: string;
  owner?: string;
  ownerRenounced?: boolean;
  /** Heuristic, from the deployed bytecode. Labelled as such in the report. */
  capabilities?: string[];
}

export interface Dossier {
  title: string;
  generatedAt: string;
  token: {
    chain: string;
    address: string;
    symbol?: string;
    priceUsd?: number;
    liquidityUsd?: number;
    deepestPoolUsd?: number;
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
  chainResolution: ChainResolutionInfo;
  /** Read directly from the chain; present whenever an RPC answered. */
  contract?: ContractFacts;
  /**
   * Signed statement of what produced this report, so it can be checked by
   * someone who does not trust us. See src/attest.ts.
   */
  attestation?: Attestation;
}

export async function buildDossier(req: DossierRequest): Promise<Dossier> {
  let chain = req.chain;
  let chainResolution: ChainResolutionInfo = {
    source: "specified",
    ambiguous: false,
    alternatives: [],
  };
  if (!chain) {
    const resolved = await resolveChain(req.tokenAddress);
    if (resolved.status === "not_found") throw new ChainNotFoundError();
    if (resolved.status === "unavailable") throw new SourcesUnavailableError();
    chain = resolved.chain;
    chainResolution = {
      source: "auto-detected",
      ambiguous: resolved.ambiguous,
      alternatives: resolved.alternatives,
    };
  }

  // One fetch, shared with the engine. The report's own figures and the risk
  // checks must describe the same snapshot: fetching separately let a document
  // print a tax rate in one section while the checks table said the security
  // source had returned nothing.
  const snapshot = await fetchSources(chain, req.tokenAddress);
  const { sec, market, chain: chainFacts } = snapshot;

  if (sec.status === "unavailable" && market.status === "unavailable") {
    throw new SourcesUnavailableError();
  }
  // An outage is "we could not look"; this is "we looked, and there is nothing".
  // Only the second means there is no deliverable to charge for.
  //
  // The chain gives the sharpest version of this: if there is no code at the
  // address, the buyer sent a wallet or a contract that was never deployed, and
  // saying so is more useful than "no market found".
  if (chainFacts.status === "ok" && !chainFacts.isContract) {
    throw new NotAContractError(chain, req.tokenAddress);
  }
  if (sec.status === "not_found" && market.status === "not_found") {
    throw new TokenNotFoundError(chain, req.tokenAddress);
  }

  const verdict = await evaluate({ chain, tokenAddress: req.tokenAddress, action: "buy" }, snapshot);

  // Everything the signature commits to: which sources were read, when, and
  // what they returned, plus the findings themselves. Anyone can recompute the
  // hash from the payload and check it against the published key.
  const observations: SourceObservation[] = [
    {
      source: "goplus",
      status: sec.status,
      url: sec.status === "ok" ? sec.provenance?.url : undefined,
      retrievedAt: sec.status === "ok" ? sec.provenance?.retrievedAt : undefined,
      responseSha256: sec.status === "ok" ? sec.provenance?.responseSha256 : undefined,
    },
    {
      source: "dexscreener",
      status: market.status,
      url: market.status === "ok" ? market.provenance?.url : undefined,
      retrievedAt: market.status === "ok" ? market.provenance?.retrievedAt : undefined,
      responseSha256: market.status === "ok" ? market.provenance?.responseSha256 : undefined,
    },
    {
      source: `${chain}-rpc`,
      status: chainFacts.status,
      url: chainFacts.status === "ok" ? chainFacts.provenance?.url : undefined,
      retrievedAt: chainFacts.status === "ok" ? chainFacts.provenance?.retrievedAt : undefined,
    },
  ];

  const reportId = randomUUID();
  const attestation = attest(
    {
      schemaVersion: SCHEMA_VERSION,
      methodologyVersion: METHODOLOGY_VERSION,
      reportId,
      requestSha256: sha256(canonicalJson({ chain, tokenAddress: req.tokenAddress.toLowerCase() })),
      token: { chain, address: req.tokenAddress.toLowerCase() },
      result: {
        verdict: verdict.verdict,
        coverage: verdict.confidence,
        maxSizeUsd: verdict.maxSizeUsd,
        checks: Object.fromEntries(
          Object.entries(verdict.checks).map(([k, v]) => [k, v.status]),
        ),
      },
      chainId: chainFacts.status === "ok" ? chainFacts.chainId : undefined,
      blockNumber: chainFacts.status === "ok" ? chainFacts.blockNumber : undefined,
      observations,
      issuedAt: new Date().toISOString(),
      issuer: { agentId: 7012, name: "Dossier" },
    },
    `${config.publicOrigin}/verify`,
  );

  const sources: string[] = [];
  if (sec.status === "ok") sources.push("GoPlus");
  if (market.status === "ok") sources.push("DexScreener");
  if (chainFacts.status === "ok") sources.push(`${chain} RPC`);

  return {
    title: `Due-Diligence Dossier — ${
      (market.status === "ok" ? market.symbol : undefined) ??
      (chainFacts.status === "ok" ? chainFacts.symbol || chainFacts.name : undefined) ??
      req.tokenAddress.slice(0, 8)
    }`,
    generatedAt: new Date().toISOString(),
    token: {
      chain,
      address: req.tokenAddress,
      symbol:
        (market.status === "ok" ? market.symbol : undefined) ??
        (chainFacts.status === "ok" ? chainFacts.symbol : undefined),
      priceUsd: market.status === "ok" ? market.priceUsd : undefined,
      liquidityUsd: market.status === "ok" ? market.liquidityUsd : undefined,
      deepestPoolUsd: market.status === "ok" ? market.deepestPoolUsd : undefined,
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
    chainResolution,
    contract:
      chainFacts.status === "ok"
        ? {
            isContract: chainFacts.isContract,
            name: chainFacts.name,
            symbol: chainFacts.symbol,
            decimals: chainFacts.decimals,
            totalSupply: chainFacts.totalSupply,
            proxyImplementation: chainFacts.proxyImplementation,
            proxyAdmin: chainFacts.proxyAdmin,
            owner: chainFacts.owner,
            ownerRenounced: chainFacts.ownerRenounced,
            capabilities: chainFacts.capabilities,
          }
        : undefined,
    attestation,
  };
}
