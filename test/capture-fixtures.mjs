// Records real upstream responses into test/fixtures/ so the deterministic
// tests run against data the sources actually returned, not data we imagined.
//
// Run deliberately, not in CI:  node test/capture-fixtures.mjs
// CI replays the committed fixtures and never touches the network.
import { writeFileSync, mkdirSync } from "node:fs";

const DIR = new URL("./fixtures/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

const CASES = [
  { name: "cake-bsc", chainId: "56", address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" },
  { name: "uni-eth", chainId: "1", address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" },
  { name: "usdt0-xlayer", chainId: "196", address: "0x779ded0c9e1022225f8e0630b35a9b54be713736" },
  { name: "nowhere", chainId: "56", address: "0x1234567890abcdef1234567890abcdef12345678" },
];

const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return { status: res.status, body: await res.json() };
};

const out = {};
for (const c of CASES) {
  out[c.name] = {
    address: c.address,
    chainId: c.chainId,
    goplus: await get(
      `https://api.gopluslabs.io/api/v1/token_security/${c.chainId}?contract_addresses=${c.address}`,
    ),
    dexscreener: await get(`https://api.dexscreener.com/latest/dex/tokens/${c.address}`),
  };
  const g = out[c.name].goplus.body?.result?.[c.address.toLowerCase()] ? "ok" : "empty";
  const d = (out[c.name].dexscreener.body?.pairs || []).length;
  console.log(`  ${c.name.padEnd(14)} goplus=${g}  dexscreener pairs=${d}`);
  await new Promise((r) => setTimeout(r, 900)); // be polite to free APIs
}

writeFileSync(DIR + "upstream.json", JSON.stringify(out, null, 2));
console.log(`  wrote ${DIR}upstream.json`);
