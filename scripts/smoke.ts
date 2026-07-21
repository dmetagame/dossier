import { app } from "../src/app";

async function main() {
  const health = await app.request("/health");
  console.log("health", health.status, await health.json());

  const v = await app.request("/verdict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chain: "bsc", tokenAddress: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", amountUsd: 5000 }),
  });
  console.log("verdict status", v.status);
  const j: any = await v.json();
  console.log("verdict", { verdict: j.verdict, maxSizeUsd: j.maxSizeUsd, confidence: j.confidence, r0: j.reasons?.[0] });
}
main();
