// Benchmark harness: established tokens must never "abort"; risky/fresh tokens
// must never "proceed"; GoPlus-flagged honeypots must "abort". Run:
//   NODE_OPTIONS=--dns-result-order=ipv4first pnpm tsx scripts/benchmark.ts
import { evaluate } from "../src/engine/engine";
import { fetchDexScreener } from "../src/engine/sources/dexscreener";

interface Case {
  label: string;
  chain: string;
  address: string;
  expect: "not-abort" | "not-proceed" | "abort";
}

const ESTABLISHED: Case[] = [
  { label: "CAKE (bsc)", chain: "bsc", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", expect: "not-abort" },
  { label: "UNI (eth)", chain: "ethereum", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", expect: "not-abort" },
  { label: "LINK (eth)", chain: "ethereum", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", expect: "not-abort" },
  { label: "AAVE (eth)", chain: "ethereum", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", expect: "not-abort" },
  { label: "PEPE (eth)", chain: "ethereum", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", expect: "not-abort" },
];

async function freshRisky(count: number): Promise<Case[]> {
  // Live sample: newest low-liquidity pairs across common meme search terms.
  const seen = new Set<string>();
  const cases: Case[] = [];
  for (const q of ["pepe", "moon", "baby", "elon", "ai"]) {
    if (cases.length >= count) break;
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`, {
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res?.ok) continue;
    const json = (await res.json()) as { pairs?: any[] };
    for (const p of json.pairs ?? []) {
      if (cases.length >= count) break;
      const liq = p.liquidity?.usd ?? 0;
      const addr = p.baseToken?.address;
      const chain = p.chainId;
      if (!addr || seen.has(addr)) continue;
      if (!["bsc", "ethereum", "base"].includes(chain)) continue;
      if (liq < 500 || liq > 60_000) continue;
      seen.add(addr);
      // One thin pair doesn't make the TOKEN thin — a copycat symbol can have
      // deep main pools elsewhere. Only assert "not-proceed" when the token's
      // aggregate liquidity is safely below the engine's $100k warn line.
      const snap = await fetchDexScreener(chain, addr);
      await new Promise((r) => setTimeout(r, 1000));
      if (snap.status !== "ok" || (snap.liquidityUsd ?? 0) >= 80_000) continue;
      cases.push({
        label: `${p.baseToken.symbol} (${chain}, $${Math.round(snap.liquidityUsd ?? liq)} liq)`,
        chain,
        address: addr,
        expect: "not-proceed",
      });
    }
  }
  return cases;
}

const results: Array<{ label: string; expect: string; verdict: string; maxSizeUsd: number | null; confidence: number; pass: boolean; top: string }> = [];

const risky = await freshRisky(8);
for (const c of [...ESTABLISHED, ...risky]) {
  try {
    const v = await evaluate({ chain: c.chain, tokenAddress: c.address, action: "buy", amountUsd: 500 });
    const pass =
      c.expect === "not-abort" ? v.verdict !== "abort" :
      c.expect === "abort" ? v.verdict === "abort" :
      v.verdict !== "proceed";
    results.push({ label: c.label, expect: c.expect, verdict: v.verdict, maxSizeUsd: v.maxSizeUsd, confidence: v.confidence, pass, top: v.reasons[0] ?? "" });
  } catch (e) {
    results.push({ label: c.label, expect: c.expect, verdict: "ERROR", maxSizeUsd: null, confidence: 0, pass: false, top: String(e) });
  }
  await new Promise((r) => setTimeout(r, 5000)); // free APIs have per-minute budgets; the run must not eat its own data quality
}

let failures = 0;
for (const r of results) {
  if (!r.pass) failures++;
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.label.padEnd(34)} expect=${r.expect.padEnd(11)} got=${r.verdict.padEnd(8)} cap=$${r.maxSizeUsd ?? "-"} conf=${r.confidence}  ${r.top}`,
  );
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
