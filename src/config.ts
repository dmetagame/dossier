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
  // Dossier is a richer artifact (a full formatted report), priced above a verdict.
  dossierPrice: process.env.DOSSIER_PRICE ?? "$0.50",
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
  // Shared secret for the ASP-side A2A daemon: lets our own job-fulfillment
  // sessions fetch reports without paying our own x402 gate. Never a buyer path.
  internalKey: process.env.INTERNAL_KEY ?? "",
  // Canonical public origin, advertised as the resource URL in the payment
  // challenge. Behind Caddy the request arrives over plain HTTP, so a URL
  // derived from it advertises `http://` even though buyers reach us over TLS,
  // and a security-conscious client is right to refuse that downgrade.
  publicOrigin: (process.env.PUBLIC_ORIGIN ?? "https://dossier.rouma.xyz").replace(/\/+$/, ""),
} as const;

export function paymentConfigured(): boolean {
  return Boolean(config.payTo && config.okx.apiKey && config.okx.secretKey && config.okx.passphrase);
}
