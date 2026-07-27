# Dossier

One paid call turns a token address into a polished, executive-ready due-diligence
report. Live on OKX.AI as an A2MCP service (agent #7012) at
`https://dossier.rouma.xyz/dossier`, paid per call over x402 on X Layer.

An agent or analyst sends a token address; Dossier returns a **finished document**,
not a data dump: risk verdict up top, safe position size, security flags, liquidity,
market activity, and holder distribution, compiled deterministically from live
GoPlus + DexScreener data and rendered as a self-contained HTML report that reads,
shares, and prints to PDF. `format: "json"` returns the same content as structured data.

Free sample of a real generated report: https://dossier.rouma.xyz/dossier/sample

## Endpoints

| Route | Method | Price | What it does |
|---|---|---|---|
| `/dossier` | GET, POST | 0.5 USD₮0 | Full due-diligence report (`html` default, `json` optional) |
| `/verdict` | GET, POST | 0.2 USD₮0 | Companion service (agent #7008): the risk decision alone as JSON |
| `/dossier/recovery` | GET, POST | free | Re-fetch a report you already paid for (`paymentTransaction` or `jobId`) |
| `/dossier/preflight` | GET, POST | free | Coverage check for a token before you pay |
| `/dossier/sample` | GET | free | Real sample report, cached |
| `/` | GET | free | Landing page |
| `/info` | GET | free | Machine-readable service description |
| `/health` | GET | free | Status |

Parameters: `{"tokenAddress": "0x…", "chain": "…", "format": "html|json"}`. They may be
sent as a JSON body or as query-string parameters, on either method — buyers' x402
clients replay differently and OKX's own `payment quote` defaults to GET, so a
POST-body-only service would answer a paying caller with 400.

`chain` is optional. It is auto-detected from live markets; when an address is deployed
on several chains the deepest-liquidity deployment is analysed and the report states
which chain it used and what the alternatives were.

## Knowing what you get before you pay

The payment challenge carries the input contract, so a cold agent can discover
the required fields before authorising payment:

```
extensions.outputSchema.input = { type: "http", method: "POST",
  contentType: "application/json", schema: { required: ["tokenAddress"], … } }
```

It lives in `extensions` rather than in the `accepts` entries on purpose. Those
are what the client signs over, and an extra field there risks a verification
mismatch at the facilitator.

Coverage is a separate question from inputs: a token with no DEX pool has no
price, liquidity, volume, or size cap, whatever the request looks like. Ask
first, free:

```bash
curl "https://dossier.rouma.xyz/dossier/preflight?tokenAddress=0x…&chain=(optional)"
```

It returns the resolved token and chain, which sources hold it, the expected
coverage, the exact fields the report will and will not contain, and whether it
can be produced at all. Coverage comes from the same engine that writes the
report, so the preflight cannot promise a number the paid deliverable then
contradicts. It deliberately withholds the verdict, the reasons, the size cap
and every security flag: it tells you whether the report is worth buying, not
what it says.

When neither source has a record of an address, the paid endpoint answers 404
and takes no payment. Settlement only happens on a 2xx, so a token nothing has
heard of cannot be charged for.

## Recovery

A paid response can be lost for reasons unrelated to this service: the client crashes,
the connection drops after settlement, the file is overwritten. Every delivered report
is archived (90 days, 5000 records, pruned) and can be re-fetched:

```bash
# paid over x402
curl "https://dossier.rouma.xyz/dossier/recovery?paymentTransaction=0x…"
# bought as a marketplace task
curl "https://dossier.rouma.xyz/dossier/recovery?jobId=0x…"
```

It returns the archived bytes, identical to what was delivered, with the request,
delivery timestamp, and settlement transaction or job id attached.

Recovery **requires one of those two proofs**. A request-parameters hash is deliberately
refused on its own, because those parameters are guessable for any popular token and
accepting them would hand a paid report to someone who never bought one. Sending the
original request as well is checked and must match.

The job id exists because a task-level buyer never signs an x402 payment: our fulfilment
daemon delivers their report into the job channel, so there is no settlement transaction
to key recovery on, and without this they were the one class of buyer who could not
re-fetch. The daemon stamps the job id on the copy it sends, and the service accepts that
header only from the daemon — otherwise a buyer could stamp someone else's job id onto
their own record and shadow the real deliverable.

Neither proof is a secret in the cryptographic sense: a determined observer could read a
transfer to the payout address off-chain. This is a guard against casual free reports,
not a confidentiality boundary, and it is proportionate — the reports are built from free
public data, a full sample is published, and an attacker only ever reaches a report on a
token somebody else chose.

Each delivery is archived under its own id, so two buyers asking about the same token
cannot evict each other's record. A job delivered more than once resolves to the most
recent copy, which is the one the buyer actually received.

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

The service runs on its own host behind Caddy (automatic TLS), not on a shared
platform: OKX's review environment could not reach a `*.vercel.app` host, and the
facilitator handshake was unreliable from that runtime.

```bash
git pull
npx esbuild src/server.ts --bundle --platform=node --target=node20 \
  --format=esm --outfile=dist/server.mjs
sudo systemctl restart dossier
```

Verify the new code is actually in the bundle before restarting — a silent build
failure otherwise leaves the previous version serving:

```bash
grep -c "<a string from your change>" dist/server.mjs
```

A `src/vercel.ts` entry and `pnpm build:api` are kept working for serverless targets,
with `vercel.json` pinning `framework: null` (a framework preset once built a second
broken lambda that captured `/`). That path is not what serves production.

## Delivery model

Dossier is an **A2MCP / x402** service, so delivery is **pull-based**: after the buyer
pays, their client replays the request to the endpoint and receives the report in the
response body. This is OKX's designed flow for x402 — there is no seller-side push or
escrow `deliver` step (the CLI explicitly rejects `deliver` for paymentMode 3, and
backend attachment registration is not available for x402 tasks). The practical
consequence is that the **endpoint host must be reachable from the buyer's environment**,
which is why the service runs on a dedicated domain rather than a shared `*.vercel.app`
host that some corporate networks filter.

An `okx-a2a` daemon (on an always-on VPS, not in this repo) additionally watches accepted
jobs and can send the report summary plus retrieval details to the buyer as an A2A/XMTP
message — a best-effort courtesy channel, not a substitute for the endpoint pull.
