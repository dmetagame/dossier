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
 * A buyer whose call 4xx'd shows `paid:true, settled:absent`. That is the exact
 * shape of "they tried to pay, we could not serve them, and they were not
 * charged", which is the thing we most often need to prove.
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
  if (!header) return {};
  try {
    const r = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    const tx = r.transaction ?? r.txHash ?? r.tx;
    const payer = r.payer ?? r.from ?? r.payerAddress;
    return {
      ...(tx ? { settled: String(tx) } : {}),
      ...(payer ? { payer: String(payer) } : {}),
    };
  } catch {
    // A receipt we cannot parse must not cost us the rest of the line.
    return {};
  }
}

/** Static assets say nothing worth keeping and would drown everything else. */
export function isNoise(path: string): boolean {
  return path.startsWith("/f/") || path === "/favicon.ico";
}

export function format(line: ReqLine): string {
  return "[req] " + JSON.stringify(line);
}
