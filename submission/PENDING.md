# Pending decisions

## 1. Listing copy: half fixed, half blocked

**Agent description: DONE (2026-07-27 evening).** It no longer claims a "safe position
size". It now says "a heuristic size cap", and gained two things it had been missing: that
the report reads the chain directly, and that every report is signed so a buyer can verify
it independently. 494 of 500 characters.

**Service description: BLOCKED.** The API refuses it:

```
Wallet API error (code=81001): service in use, only name/description can be modified: 36013
```

and the CLI will not build a `--service` payload without `serviceType`, `fee` and
`endpoint`, which are exactly the fields the API rejects for an in-use service. So the
service description still reads "safe position size". Try the OKX web portal, which may
allow a description-only edit that the CLI cannot express. Do not delete and recreate the
service to work around it: that would discard the service id, and with it the sales and
review history attached to it.

Ready-to-paste replacement (488 chars, fits the limit):

> Produces a complete, formatted due-diligence report on a token for an agent or analyst.
> Covers the risk decision, a heuristic size cap, security flags, liquidity, market
> activity, holder concentration, and the contract's on-chain identity. Every report is
> signed, so the buyer can verify it. The finished report is returned directly in the paid
> response.
> 1. Token contract address 2. Optional: chain name, detected automatically when
> unambiguous 3. Optional: output format, report or data

**Cost of the edit, as warned.** The agent went from approvalStatus 4 "Listed" to 3,
"Listing under review", statusLabel "not listed". While in that state it is absent from
public search, `www.okx.ai/agents/7012` returns 404, and `designated-route` returns zero
services, so the marketplace purchase path is closed. The endpoint itself is unaffected:
`/dossier` still answers 402, `x402-check` still reports valid, and a buyer holding the
URL can still pay and be served.

The review remark reads "AI quality review suggested pass", which is the same signal that
preceded approval last time. Nothing to do but wait for it to clear.

## 2. Rotate the OKX API credentials

They went through a chat transcript on 21 July and again on 27 July. The 21 July set was
dead by 27 July, which is plausibly why. Create a new key, verify, then delete the old one.

## 3. Verdict (#7008)

Removed from this repo and from the running service on 2026-07-27. The on-chain agent
record still exists and is not deactivated. Deactivating it is a separate, outward-facing
action; decide whether it is worth doing at all, since an inactive listing harms nothing.
