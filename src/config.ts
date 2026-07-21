// Payment-critical values come from env. The x402 challenge shape, asset, and
// on-chain verification are now handled by the official OKX SDK
// (@okxweb3/x402-hono) — see src/app.ts. We only supply price, payout address,
// and the facilitator API credentials.
export const config = {
  // CAIP-2 network id for X Layer mainnet.
  network: (process.env.X402_NETWORK ?? "eip155:196") as `${string}:${string}`,
  // Price per verdict call as a human USD string ("$0.20"). The SDK maps this
  // to USD₮0 (the official settlement stablecoin on X Layer) automatically.
  price: process.env.PRICE ?? "$0.20",
  // ASP payout address (the OKX-registered wallet). Empty until we have it from
  // `onchainos wallet` — the middleware is not mounted while this is empty, so a
  // misconfigured deploy serves nothing rather than quoting a bad recipient.
  payTo: (process.env.PAY_TO ?? "") as `0x${string}` | "",
  // OKX facilitator credentials (dev portal). Used server-side to verify/settle
  // payments; runs from Vercel, not the IP-blocked dev box.
  okx: {
    apiKey: process.env.OKX_API_KEY ?? "",
    secretKey: process.env.OKX_SECRET_KEY ?? "",
    passphrase: process.env.OKX_PASSPHRASE ?? "",
  },
  // DEV ONLY: skip the payment middleware so the engine can be exercised
  // locally. The deployed service must never set this; /health reports it.
  devSkipPayment: process.env.DEV_SKIP_PAYMENT === "1",
} as const;

export function paymentConfigured(): boolean {
  return Boolean(config.payTo && config.okx.apiKey && config.okx.secretKey && config.okx.passphrase);
}
