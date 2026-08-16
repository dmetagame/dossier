# OKX.AI listing and remediation record

Updated 2026-08-16. **This file previously described Verdict (#7008), which is parked and
is not the entry.** It records Dossier (#7012), including the delisting incident and the
current resubmission state, so the repository does not claim that a rejected listing is live.

Listing constraints: the agent name is a brand, 3 to 25 characters. The service name is a
noun phrase, 5 to 30 characters, with no price in it. The service description must fit in
500 characters and carry the parameter names, types, requirements, and concrete examples.
The fee field is digits only.

## Current marketplace state

| Field | Value |
|---|---|
| Agent | Dossier, #7012 |
| Status | Listing under review (`approvalDisplayStatus: 2`; review status `3`); not listed until review completes |
| Service | Token Due-Diligence Report, id 36013 |
| Type | API service (A2MCP) |
| Fee | 0.01 |
| Endpoint | https://dossier.rouma.xyz/dossier |
| Payout wallet | 0x51c25782af63381056cd1c3c59c0544628d67697 |
| Record | 29 sold, security rate 4.43 (the counter includes internal tests) |
| Public page | https://www.okx.ai/agents/7012 |
| Metadata update | OKX transaction `0xe88ef7a8e21678e5728d3a1286709245a27df7d18bc1d3867334f554f8b6d8a3` |

The endpoint remains available while marketplace review is pending. A live `x402-check`
against `https://dossier.rouma.xyz/dossier` returns the exact X Layer requirement: network
`eip155:196`, USD₮0 asset `0x779ded0c9e1022225f8e0630b35a9b54be713736`, amount `10000`,
and payout wallet `0x51c25782af63381056cd1c3c59c0544628d67697`.

## Agent description

> Dossier turns a single request into a polished, executive-ready due-diligence report on any
> token. It compiles live security, liquidity, market-activity and holder-distribution data,
> plus direct reads from the chain itself, into one shareable document, with a clear risk
> decision, a heuristic size cap, and the key findings at the top. Every report is signed, so
> a buyer can verify it independently. Instead of stitching together several dashboards, an
> agent gets a finished report in one call.

## Current service description

The exact 494-character description saved to service `36013` is:

```text
Signed report: verdict, cap, security, liquidity, activity, holders. Provide: tokenAddress (string, required), example "0x779ded0c9e1022225f8e0630b35a9b54be713736"; chain (string, optional), example "xlayer", allowed ethereum,bsc,base,arbitrum,polygon,xlayer; use xlayer for X Layer; format (string, optional), example "json", allowed html,json, default html. Example: {"tokenAddress":"0x779ded0c9e1022225f8e0630b35a9b54be713736","chain":"xlayer","format":"json"}; paid response: signed report.
```

This explicitly names every call parameter, its type and requirement, allowed values, and a
complete X Layer JSON example. The endpoint returns the signed report in the paid response.

## Delisting remediation

OKX delisted the service after a buyer's paid response was withheld as `invalid_receipt`.
The production cause was the facilitator returning nullable settlement fields, combined with
an omitted chain causing X Layer token resolution to fail. The deployed fixes accept only
nullish optional receipt fields that can be reconstructed from signed requirements or a
successful verification; contradictory non-null fields remain errors. Callers are now told
to send `chain: "xlayer"` for X Layer.

Evidence from the paid replay on the production checkout (`86e690365480`):

- HTTP `200` JSON report delivered and its Ed25519 signature verified.
- Archive `ba1e188a-85ed-4f11-8706-45ec1e159cd2`, deliverable 3,367 bytes.
- Deliverable SHA-256 `83b1e7913662e3b1019f5f4769c13864f139ceb62e3bf6d82aaa971ab5cc3ceb`.
- Settlement confirmed on `eip155:196`, amount `10000`, transaction
  `0x857c04d3f25a78cc7376c520e635fa3b673158f1911a5a383bd028d2db4ba465`.

The required prompt was placed verbatim in the local `okx-a2a` owner-attention queue and
marked handled on 2026-08-16:

> Check and update my okx.ai ASP information.

That queue is owner-facing local state, not an XMTP message or independent proof of an
owner-to-ASP delivery, so it is not counted as external confirmation. No synthetic paid task
or second payment was created. The verifiable marketplace actions are the corrected service
metadata, metadata transaction above, and the resulting review state.

## Fulfilment runtime state

The production VPS runs `@okxweb3/a2a-node` **0.1.11** as the single system service
(`okx-a2a.service`, enabled and active). An inactive duplicate user unit was disabled on
2026-08-16; the local laptop daemon remains stopped. Version **0.2.6** was reviewed but not
installed: it does not remove the known long-session-key `ENAMETOOLONG` log-path risk, and
its XMTP/agent SDK and database changes require a separate staged migration and rollback
window. This package decision is operational follow-up, not a blocker in the corrected HTTP
payment path.

## Superseded wording

The listing formerly said **"safe position size"** in both the agent and service
descriptions, and this file went on repeating it after the live listing had been corrected.

It was changed because it was false in the way that matters. The figure is 1% of the
deepest pool's base-side liquidity, halved on caution. It is a liquidity-derived ceiling,
not advice about what is safe to risk, and it takes no account of the buyer's position,
conviction, or the very warnings printed beside it. On 2026-08-03 a delivery message
carrying the old phrasing told a buyer "safe position size approximately $78,345" for a
token the next line of the same message flagged as mintable with an unrenounced owner.

The service copy, report, `/info`, and delivery message now all call it a **heuristic size
cap** or **heuristic size limit**. Nothing in this repository should describe it as a safe
position size except incident records that explain why it must not be.

## Copy notes

The current product and service copy include two features absent from the original listing:

- The report carries the contract's **on-chain identity**: name, symbol, decimals, total
  supply, proxy implementation, owner, and capabilities found in its bytecode.
- Every report is **signed** and can be verified by the buyer against a published key.

The fee remains 0.01 and service id 36013 is preserved. Future description changes should
use `onchainos agent update` and should trigger a deliberate review-state check.

Do not describe the size cap as "safe" in new copy. The report labels it a heuristic size
cap and states its formula, and the listing text should not contradict the product.
