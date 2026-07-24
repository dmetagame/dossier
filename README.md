# Dossier

One paid call turns a token address into a polished, executive-ready due-diligence
report. Live on OKX.AI as an A2MCP service (agent #7012) at
`https://verdict-pi.vercel.app/dossier`, paid per call over x402 on X Layer.

An agent or analyst sends a token address; Dossier returns a **finished document**,
not a data dump: risk verdict up top, safe position size, security flags, liquidity,
market activity, and holder distribution, compiled deterministically from live
GoPlus + DexScreener data and rendered as a self-contained HTML report that reads,
shares, and prints to PDF. `format: "json"` returns the same content as structured data.

Free sample of a real generated report: https://verdict-pi.vercel.app/dossier/sample

## Endpoints

| Route | Method | Price | What it does |
|---|---|---|---|
| `/dossier` | POST | 0.5 USD₮0 | Full due-diligence report (`html` default, `json` optional) |
| `/dossier/sample` | GET | free | Real cached sample report |
| `/verdict` | POST | 0.2 USD₮0 | Companion service (agent #7008): the risk decision alone as JSON |
| `/health`, `/` | GET | free | Status and usage cards |

Request body: `{"tokenAddress": "0x…", "chain": "…", "format": "html|json"}`.
`chain` is optional — auto-detected when the address trades on exactly one supported
chain (ethereum, bsc, base, arbitrum, polygon, xlayer); genuinely ambiguous addresses
get an unpaid 400 listing the candidate chains, never a guess.

## Payment (x402 v2)

An unpaid `POST` returns `402` with a base64 `PAYMENT-REQUIRED` challenge
(`exact` scheme, `eip155:196`, USD₮0, `maxTimeoutSeconds` 300). The OKX server SDK
(`@okxweb3/x402-hono` + `OKXFacilitatorClient`) builds the challenge and performs
verify/settle; settlement happens only on 2xx responses, so failed or invalid
requests never charge the buyer. Verified end to end with a settled on-chain
purchase (X Layer tx `0xbb6e4399…19e6c`).

Design guarantees:
- **Fail closed**: missing facilitator credentials in production → paid routes 503,
  never silently free.
- **No charged errors**: bad input, unknown chains, ambiguous addresses, and data-source
  outages all return non-2xx (unpaid).
- **Cold-start hardening**: first-request facilitator sync failures retry once,
  provably without re-running a handler.

## Engine

Five deterministic checks — sellability/honeypot, contract control, liquidity depth,
market activity, holder concentration — with tri-state source handling (`ok` /
`not_found` / `unavailable`: an API outage is never treated as knowledge about the
token). Verdict is `proceed`/`caution`/`abort` plus `maxSizeUsd` (capped at 1% of
pooled base-side liquidity, halved on caution) and a data-coverage confidence score.
No LLM anywhere: results are reproducible and benchmarkable.

## Run locally

```bash
pnpm install
NODE_OPTIONS=--dns-result-order=ipv4first DEV_SKIP_PAYMENT=1 pnpm dev
curl -X POST localhost:8787/dossier -H 'content-type: application/json' \
  -d '{"tokenAddress":"0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"}'
```

`DEV_SKIP_PAYMENT=1` unmounts the payment middleware for local testing; production
requires the env vars in `.env.example` (set on the deploy host, never committed).

## Test

```bash
NODE_OPTIONS=--dns-result-order=ipv4first pnpm tsx scripts/benchmark.ts
```

Established tokens (CAKE, UNI, LINK, AAVE, PEPE) must never `abort`; live-sampled
thin/fresh tokens must never `proceed`. Current run: 13/13.

## Deploy

`pnpm build:api` bundles `src/vercel.ts` into `api/index.js` (esbuild); `vercel.json`
pins `framework: null` (a framework preset once built a second broken lambda that
captured `/`). Deploys are manual: `pnpm deploy:prod`.

## A2A task fulfillment

Marketplace task-flow purchases are fulfilled by an `okx-a2a` daemon (hosted on an
always-on VPS, not in this repo): each accepted job fetches the report server-side
via an internal-key header (a non-buyer path that skips the x402 gate) and delivers
it through the job's encrypted file channel and XMTP message thread — x402-mode
tasks have no escrow `deliver` step, so those are the only seller-side channels.
