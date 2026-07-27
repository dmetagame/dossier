// Test harness.
//
// Two rules make these tests worth having:
//
//  1. No test touches the network. Upstream responses come from
//     test/fixtures/upstream.json, recorded from the real APIs by
//     test/capture-fixtures.mjs. Any request the fixtures do not cover throws,
//     so a test can never quietly start depending on live data and start
//     failing for reasons that have nothing to do with our code.
//  2. Nothing writes outside a temp directory, and every temp directory is
//     removed afterwards.

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Recorded {
  address: string;
  chainId: string;
  goplus: { status: number; body: unknown };
  dexscreener: { status: number; body: unknown };
}

export const FIXTURES: Record<string, Recorded> = JSON.parse(
  readFileSync(new URL("./fixtures/upstream.json", import.meta.url), "utf8"),
);

const goplusUrl = (chainId: string, address: string) =>
  `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`;
const dexUrl = (address: string) => `https://api.dexscreener.com/latest/dex/tokens/${address}`;

export type FailureMode = "timeout" | "500" | "429";

interface StubOptions {
  /** Fixture names to serve. */
  cases?: string[];
  /** Make one source fail, to exercise the tri-state handling. */
  fail?: { goplus?: FailureMode; dexscreener?: FailureMode };
}

const realFetch = globalThis.fetch;

/** Installs the stub. Returns a restore function. */
export function stubUpstream(opts: StubOptions = {}): () => void {
  const cases = opts.cases ?? Object.keys(FIXTURES);
  const map = new Map<string, { status: number; body: unknown; source: "goplus" | "dexscreener" }>();
  for (const name of cases) {
    const f = FIXTURES[name];
    if (!f) throw new Error(`no fixture named ${name}`);
    map.set(goplusUrl(f.chainId, f.address), { ...f.goplus, source: "goplus" });
    map.set(dexUrl(f.address), { ...f.dexscreener, source: "dexscreener" });
  }

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const hit = map.get(url);
    if (!hit) {
      throw new Error(
        `test made an unexpected network call: ${url}\n` +
          `Add a fixture for it, or the test is depending on live data.`,
      );
    }
    const mode = opts.fail?.[hit.source];
    if (mode === "timeout") throw new Error("simulated network timeout");
    if (mode === "500") return new Response("upstream error", { status: 500 });
    if (mode === "429") return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = realFetch;
  };
}

/** A temp archive directory that cleans itself up. */
export function tempArchive(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dossier-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const ADDR = {
  cake: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
  uni: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  usdt0: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  nowhere: "0x1234567890abcdef1234567890abcdef12345678",
} as const;
