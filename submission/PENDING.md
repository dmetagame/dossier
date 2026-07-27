# Pending decisions

## 1. Listing copy: half fixed, half blocked

**Agent description: DONE (2026-07-27 evening).** It no longer claims a "safe position
size". It now says "a heuristic size cap", and gained two things it had been missing: that
the report reads the chain directly, and that every report is signed so a buyer can verify
it independently. 494 of 500 characters.

**Service description: BLOCKED, and closed as such (2026-07-28).** Both routes refuse it.

The CLI cannot express the edit: the API returns

```
Wallet API error (code=81001): service in use, only name/description can be modified: 36013
```

for any payload touching `serviceType`, `fee` or `endpoint`, and the CLI will not build a
`--service` payload without all three. The OKX web portal refuses it too, which means the
lock is server-side rather than a CLI limitation. There is no path from our side.

**Decision: leave it.** The residue is one field. The service description still reads "safe
position size" while the report, the landing page, the README, `/info`, the agent
description and the daemon's message to buyers all say "heuristic size cap". A buyer who
reads the listing and then opens the report sees the report's wording, which is the
conservative one.

Rejected on purpose: deleting and recreating the service to force new copy. That discards
service id 36013 and the sales and review history attached to it, which is a real loss in
exchange for a wording change.

**Retry trigger, if you ever want it:** try again if OKX ever stops flagging the service as
in use, or if support can clear the lock. Not worth chasing.

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
