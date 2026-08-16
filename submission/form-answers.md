# Submission answers — OKX.AI Genesis Hackathon

Entry: **Dossier**, agent **#7012**, submitted while listed on OKX.AI.
Updated 2026-07-27, after the external review and the work that followed it.

This is the original submission snapshot. The current status changed on 2026-08-15 to
**Listing under review** after the delisting remediation; see `listing.md`.

## Identity

| Field | Value |
|---|---|
| ASP name | Dossier |
| Agent ID | 7012 (on-chain, X Layer) |
| Listing | https://www.okx.ai/agents/7012 |
| Service | Token Due-Diligence Report (A2MCP) |
| Price | 0.01 USD₮0 per call, x402 on X Layer (eip155:196) |
| Endpoint | https://dossier.rouma.xyz/dossier |
| Site | https://dossier.rouma.xyz |
| Status at original submission snapshot | Listed, eligible for task recommendations, online |
| Marketplace record | ★4.5, 83.33% positive, 28 sold, 6 written reviews (2026-08-04). See `revenue-ledger.md`: 11 of the 28 are external, from 6 distinct buyers |
| X post | https://x.com/Herboobakar/status/2081858337553973363 |
| Demo video | https://youtu.be/6Uq1ZCxPQ2o |
| Build direction | Professional Asset Creation (OKX priority ASP direction 1) |
| Categories to target | Best Product (primary), Revenue Rocket (secondary) |

## One-line pitch

Dossier turns one token address into a finished, executive-ready due-diligence report,
paid per call over x402 on X Layer, with a signature anyone can verify.

## What it does

An agent or an analyst sends a contract address. Dossier returns a complete document
rather than a data dump: the risk decision at the top, the position size the market can
actually absorb, five risk checks each with its reason, the on-chain identity of the
contract, and the market and holder picture underneath. It reads, shares, and prints to
PDF. `format: "json"` returns the same content structured for machines.

It replaces an hour of stitching together a safety scanner, a DEX chart, a holders page
and a block explorer with a single paid call an agent can make on its own.

## Why it fits the track

Single request in, one finished asset out. The analysis is deterministic with no language
model anywhere, so the same token and the same data produce the same report every time,
and any report can be checked afterwards against its signature.

## What makes it different

**It refuses to guess.** Sources are tri-state: `ok`, `not_found`, `unavailable`. An API
outage is never recorded as knowledge. When a source cannot answer, the affected checks
are marked unknown, the coverage score drops, and the report states which fields are
missing instead of filling them in.

**It will not charge for what it cannot deliver.** Settlement happens only on a 2xx. A bad
request, an unknown token, an address with no contract code, or a source outage each
return a non-2xx and take no payment. A free preflight tells a buyer the expected coverage
and the exact fields the report will contain, before they pay anything.

**A cold agent can discover how to call it before paying.** The x402 challenge carries the
input contract, so a buying agent reads the required fields out of the challenge rather
than discovering them from a 400 after the money has moved.

**Reports are signed and independently verifiable.** Every report carries a canonical hash
of its inputs, findings and per-source observations, an Ed25519 signature over that hash,
the chain id and block height the on-chain reads were taken at, and for each source when
it was read plus a sha256 of its response. The verifier at /verify runs in the reader's own
browser against a key published at a well-known URL, so verifying requires no wallet, no
account, and no trust in us.

**Three sources, including the chain itself.** GoPlus for security, DexScreener for
markets, and direct JSON-RPC reads for contract identity, supply, proxy implementation,
owner and bytecode capabilities. That third source is why a token with no DEX pool, such
as X Layer's own USD₮0, still produces a report that names it rather than an anonymous hex
string, and correctly flags it as an upgradeable proxy.

**Buyers can get their report back.** Recovery returns the exact bytes that were delivered,
keyed to the settlement transaction, or to the marketplace job id for task-level buyers who
never sign an x402 payment themselves.

## Free surface, no signup

| Route | What it gives you |
|---|---|
| `/dossier/sample` | A real report, generated on request |
| `/dossier/preflight` | Expected coverage and exact fields, before paying |
| `/verify` | Verify any report in your own browser |
| `/.well-known/dossier-signing-key.json` | The public key to pin |
| `/info` | Machine-readable service description |

## Engineering

Deterministic engine, five checks, tri-state sources. 112 automated tests that replay
recorded upstream responses and fail on any unexpected network call, plus CI on every push
running typecheck, the suite, a build, a check that generated assets match their sources,
and a smoke test of the built bundle. Runs on its own host behind automatic TLS, deployed
as a single file.

## Independent review

An outside reviewer bought the service end to end through the marketplace, audited it, and
sent detailed findings. Every technical item was fixed the same day: the input contract now
rides in the payment challenge, the canonical resource URL is https, the coverage score is
labelled as coverage rather than confidence, the size cap is labelled a heuristic with its
formula stated, deliverables carry a filename, a free coverage preflight exists, unknown
addresses are refused before payment, X Layer coverage improved by reading the chain
directly, and reports are now signed with a public verifier.

Their review, left on the listing:

> Clear, polished due-diligence report with a conservative verdict and explicit unknowns
> instead of fabricated data. The self-contained HTML was immediately usable, and the paid
> replay recovery returned the complete deliverable. A strong foundation for agent-ready
> token research.

---

## Notes to self, not for the form

- The marketplace counter includes our own test tasks. **This note used to say "two
  external buyers", which is now badly out of date and understates the entry.** The
  actual record as of 2026-08-04, compiled from on-chain job ids in
  `submission/revenue-ledger.md`: 28 completed tasks, of which **11 are from 6 distinct
  external buyers** totalling **4.03 USD₮0**, and 17 are our own. Agent **#1757 bought
  five times**, which is the number worth quoting: a repeat external buyer says more than
  any first-purchase count. Never present "28 sold" as organic traction.
- Rotate the OKX API credentials once the deadline passes. They went through a chat
  transcript on 21 July and again on 27 July.
- The companion agent Verdict (#7008) is parked and is not part of this entry.
