import { config, atomicPrice } from "./config.js";

// x402 v2: the 402 response carries a base64-encoded JSON challenge in the
// PAYMENT-REQUIRED header; the buyer replays with a signed payment header.
// Shape follows the accepts[] scheme family ("exact" = one-shot transfer),
// with outputSchema.input declaring how the paid replay must call us
// (POST, JSON body) so agent-side tooling can fill params automatically.
//
// OPEN ITEM (blocking before listing): settlement verification. The seller
// side must verify the replayed payment header with the facilitator before
// serving the result. The facilitator endpoint for OKX's deployment is
// documented on the OKX developer portal (unreachable from the dev box —
// verify from the deployed environment or the user's phone/VPN).

export interface ExactAccept {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  outputSchema: {
    input: {
      type: "http";
      method: "POST";
      bodyType: "json";
      body: Record<string, unknown>;
    };
  };
}

export function buildChallenge(): { headerValue: string; body: Record<string, unknown> } {
  if (!config.assetAddress || !config.payTo) {
    throw new Error("ASSET_ADDRESS and PAY_TO must be configured before emitting payment challenges");
  }
  const accept: ExactAccept = {
    scheme: "exact",
    network: config.network,
    asset: config.assetAddress,
    amount: atomicPrice(),
    payTo: config.payTo,
    maxTimeoutSeconds: 120,
    outputSchema: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        body: {
          type: "object",
          required: ["chain", "tokenAddress"],
          properties: {
            chain: { type: "string", description: "Chain of the token, e.g. xlayer, bsc, base, ethereum" },
            tokenAddress: { type: "string", description: "ERC-20 contract address to evaluate" },
            action: { type: "string", enum: ["buy", "sell", "hold", "lp"], description: "What the agent intends to do" },
            amountUsd: { type: "number", description: "Intended position size in USD" },
          },
        },
      },
    },
  };
  const challenge = { x402Version: 2, accepts: [accept] };
  return {
    headerValue: Buffer.from(JSON.stringify(challenge)).toString("base64"),
    body: challenge,
  };
}

// Returns true when the request carries a settled payment for this call.
// TODO(blocking): real facilitator verification. Until then only the
// explicit dev flag passes, so we cannot accidentally serve unpaid traffic.
export async function verifyPayment(req: Request): Promise<boolean> {
  if (config.devSkipPayment) return true;
  const paymentHeader = req.headers.get("X-PAYMENT") ?? req.headers.get("PAYMENT-SIGNATURE");
  if (!paymentHeader) return false;
  // Facilitator verify/settle call goes here once the OKX facilitator URL is
  // confirmed. Failing closed until then.
  return false;
}
