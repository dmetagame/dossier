// What a cold agent can learn about this service before it authorises payment.
//
// An external reviewer paid 0.50 USD₮0 through the OKX marketplace client and
// got a 400 back, because the client reads the required inputs from the
// PAYMENT-REQUIRED challenge, saw none, and replayed without `tokenAddress`.
// The 402 body had described the inputs all along; nothing that mattered read
// the body.
//
// So the input contract is published inside the challenge, and it lives here as
// its own module rather than inside a conditional block in app.ts, because it is
// the part of the service a buyer depends on before they can even pay us.

import { SUPPORTED_CHAINS } from "./engine/schema";

/**
 * How large the challenge extensions may get, as JSON, before we are at risk.
 *
 * The challenge travels as a base64 PAYMENT-REQUIRED *response header*, so this
 * schema is not free the way a response body is. Proxies cap header size, often
 * at 4 KB, and the failure is not a truncated field: the whole response becomes
 * a 502, on every 402, so nobody can buy. It also does not announce itself, it
 * just starts happening the first time the schema crosses the line.
 *
 * Our own path is not the constraint (Caddy sets no limit and Go allows 10 MB
 * for an upstream response header). The buyer's proxy is, and we cannot see it.
 *
 * Measured 2026-07-29: extensions 905 B of a 1378 B challenge, 1858 B on the
 * wire after base64. Budget below leaves the header near 3 KB at worst, which
 * keeps a 4 KB proxy comfortable. Raise this only with a reason, and prefer
 * moving detail into the 402 body, which has no ceiling.
 */
export const EXTENSIONS_BUDGET_BYTES = 1500;

const tokenAddressSchema = {
  type: "string",
  pattern: "^0x[a-fA-F0-9]{40}$",
  description: "EVM token contract address.",
} as const;

const chainSchema = {
  type: "string",
  enum: [...SUPPORTED_CHAINS],
  description:
    "Optional. Auto-detected from live markets; when the address is deployed on several chains the deepest-liquidity deployment is analysed and the report states which chain was used.",
} as const;

export const dossierInputSchema = {
  type: "object",
  properties: {
    tokenAddress: tokenAddressSchema,
    chain: chainSchema,
    format: {
      type: "string",
      enum: ["html", "json"],
      default: "html",
      description: "html returns the rendered report document; json returns the same data structured.",
    },
  },
  required: ["tokenAddress"],
  additionalProperties: false,
} as const;

/**
 * The `extensions` entry attached to a paid route's challenge.
 *
 * The SDK places this at the top level of the challenge, alongside `resource`.
 * It deliberately does not touch the `accepts` entries: those are what the
 * client signs over, and adding fields there risks a verification mismatch at
 * the facilitator.
 */
export function httpInputSchema(
  input: unknown,
  outputMimeType: string,
  outputDescription: string,
): Record<string, unknown> {
  return {
    outputSchema: {
      input: {
        type: "http",
        method: "POST",
        contentType: "application/json",
        // Query-string replay works too, but a JSON body is the shape every
        // client handles identically, so it is the one we advertise.
        bodyType: "json",
        schema: input,
      },
      output: { mimeType: outputMimeType, description: outputDescription },
    },
  };
}
