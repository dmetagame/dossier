// All payment-critical values come from env so nothing chain-facing is hardcoded
// before we confirm the official X Layer token/facilitator details from OKX docs.
export const config = {
  // X Layer mainnet
  chainId: Number(process.env.CHAIN_ID ?? 196),
  network: process.env.X402_NETWORK ?? "eip155:196",
  // USDT contract on X Layer — MUST be confirmed against OKX docs before listing.
  // Left empty by default so a misconfigured deploy fails loudly instead of
  // emitting a challenge that points at the wrong asset.
  assetAddress: process.env.ASSET_ADDRESS ?? "",
  assetDecimals: Number(process.env.ASSET_DECIMALS ?? 6),
  assetSymbol: process.env.ASSET_SYMBOL ?? "USDT",
  // Merchant payout address (the ASP wallet registered with OKX).
  payTo: process.env.PAY_TO ?? "",
  // Price per verdict call, human units. Listing fee on OKX.AI must match this.
  priceUsdt: process.env.PRICE_USDT ?? "0.2",
  // DEV ONLY: skip payment verification so the engine can be exercised locally.
  // The deployed service must never run with this set — /health reports it so
  // a bad deploy is visible.
  devSkipPayment: process.env.DEV_SKIP_PAYMENT === "1",
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8787",
} as const;

export function atomicPrice(): string {
  const [int, frac = ""] = config.priceUsdt.split(".");
  const fracPadded = (frac + "0".repeat(config.assetDecimals)).slice(0, config.assetDecimals);
  return String(BigInt(int || "0") * 10n ** BigInt(config.assetDecimals) + BigInt(fracPadded || "0"));
}
