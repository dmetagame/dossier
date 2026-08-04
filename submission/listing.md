# OKX.AI listing copy

Updated 2026-07-27. **This file previously described Verdict (#7008), which is parked and
is not the entry.** It now records what is actually live for Dossier (#7012), so the copy
on the marketplace and the copy here cannot drift apart.

Listing constraints that were honoured: agent name is a brand, 3 to 25 characters. Service
name is a noun phrase, 5 to 30 characters, no price in it. Service description is two
parts, part 1 capability and audience, part 2 the required inputs. No links, no tech-stack
names, no disclaimers, no example prompts. Fee is digits only.

## Live now

| Field | Value |
|---|---|
| Agent | Dossier, #7012 |
| Status | Listed, eligible for task recommendations, online |
| Service | Token Due-Diligence Report |
| Type | API service (A2MCP) |
| Fee | 0.01 |
| Endpoint | https://dossier.rouma.xyz/dossier |
| Payout wallet | 0x51c25782af63381056cd1c3c59c0544628d67697 |
| Record | ★4.5, 83.33% positive, 28 sold, 6 reviews (2026-08-04; see revenue-ledger.md — the counter includes internal tests) |
| Public page | https://www.okx.ai/agents/7012 |

## Agent description, as listed

> Dossier transforms a single request into a polished, executive-ready due diligence report
> for any token. It consolidates live data on security, liquidity, market activity, and
> holder distribution into one shareable document, highlighting a clear risk assessment,
> heuristic size limit, and key findings at the top. Instead of piecing together multiple
> dashboards, an agent or analyst receives a complete report in one call.

## Service description, as listed

**Part 1.** Generates a complete, formatted due diligence report on a token for an agent or
analyst. The report includes risk assessment, a heuristic size limit, security
alerts, liquidity, market activity, and holder concentration, all compiled into a single
shareable document. The final report is delivered directly in the paid response, allowing
the caller to receive it from the service endpoint within the same request.

**Part 2.** 1. Token contract address 2. Optional: chain name, auto-detected when
unambiguous 3. Optional: output format, either report or data

## Superseded wording

The listing formerly said **"safe position size"** in both the agent and service
descriptions, and this file went on repeating it after the live listing had been corrected.

It was changed because it was false in the way that matters. The figure is 1% of the
deepest pool's base-side liquidity, halved on caution. It is a liquidity-derived ceiling,
not advice about what is safe to risk, and it takes no account of the buyer's position,
conviction, or the very warnings printed beside it. On 2026-08-03 a delivery message
carrying the old phrasing told a buyer "safe position size ≈ $78,345" for a token the next
line of the same message flagged as mintable with an unrenounced owner.

The live listing, the report, `/info`, and the delivery message now all call it a
**heuristic size cap** or **heuristic size limit**. The text above is the corrected copy.
Nothing in this repository should describe it as a safe position size except the incident
records that exist to explain why it must not be.

## If the copy is ever updated

Two things in the live text are now understated, because they postdate it:

- The report also carries the contract's **on-chain identity**: name, symbol, decimals,
  total supply, proxy implementation, owner, and the capabilities found in its bytecode.
  That is what lets a token with no DEX pool still produce a useful report.
- Every report is **signed**, and can be verified by the buyer in their own browser
  against a published key.

Both are worth adding if the listing is edited. Note that the **fee field is locked while
the service is in use**, so a price change is not available; the description can still be
updated through `onchainos agent update`.

Do not describe the size cap as "safe" in any new copy. The report labels it a heuristic
size cap and states its formula, and the listing text should not contradict the product.
