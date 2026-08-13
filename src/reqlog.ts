import { config } from "./config";
import { validateSettlementReceipt } from "./settlement-receipt";

/**
 * One structured line per request.
 *
 * Why this exists: on 27 July the service answered /health with 200 for two
 * hours while every paid call was failing. On 28 July, asked whether a specific
 * buyer had been charged, the only way to answer was to dig through the report
 * archive and query the chain, because the log held nothing but systemd
 * lifecycle lines. Neither question should need archaeology.
 *
 * The line separates two things that are easy to conflate and that mattered in
 * that second incident:
 *
 *   `paid`    an authorisation was presented with the request
 *   `settled` money actually moved, and here is the transaction
 *
 * A buyer whose call failed can show `paid:true, settled:absent`. That means the
 * service did not validate and link a final settlement. It does not by itself
 * prove the on-chain outcome when settlement was pending or communication was
 * interrupted; those cases are reported separately as unknown.
 */

/** A request line. Short keys because these are read in bulk, by eye and by grep. */
export type ReqLine = {
  m: string;
  p: string;
  s: number;
  ms: number;
  paid?: boolean;
  settled?: string;
  payer?: string;
  token?: string;
  chain?: string;
  report?: string;
  job?: string;
  ratelimited?: true;
};

/**
 * Fields lifted from the settlement receipt.
 *
 * The receipt is public information: the transaction is on chain and the payer
 * is the address that signed it. The *authorisation* is not, which is why the
 * PAYMENT-SIGNATURE header is never read here — it is a bearer credential, and
 * a log is the last place it should end up.
 */
export function decodeReceipt(header: string | null | undefined): {
  settled?: string;
  payer?: string;
} {
  const result = validateSettlementReceipt(header, { network: config.network });
  if (!result.ok) return {};
  return {
    settled: result.receipt.transaction,
    ...(result.receipt.payer ? { payer: result.receipt.payer } : {}),
  };
}

/** Use settlement metadata already validated and linked by the payment path. */
export function linkedReceipt(value: unknown): {
  settled?: string;
  payer?: string;
} {
  if (!value || typeof value !== "object") return {};
  const r = value as Record<string, unknown>;
  if (
    r.status !== "confirmed" ||
    typeof r.transaction !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(r.transaction)
  ) {
    return {};
  }
  return {
    settled: r.transaction,
    ...(typeof r.payer === "string" ? { payer: r.payer } : {}),
  };
}

/** Static assets say nothing worth keeping and would drown everything else. */
export function isNoise(path: string): boolean {
  return path.startsWith("/f/") || path === "/favicon.ico";
}

export function format(line: ReqLine): string {
  return "[req] " + JSON.stringify(line);
}
