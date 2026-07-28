# Pending decisions

## 0. An A2A delivery does not close the sale

Found on 2026-07-28 while fixing ticker resolution, and it changes what
"delivered" means.

If a buyer's x402 replay fails, the watcher still delivers the report over A2A and
saves a deliverable record on our side. The **platform** does not count that.
`agent complete` refuses with:

```
x402_no_deliverable: Cannot complete: no deliverable received.
The x402 endpoint replay likely failed (replaySuccess=false).
```

So the buyer holds their report, the task stays `accepted`, and **we are never
paid**. Verified both directions on job `0xe8469747…`: blocked while the replay had
400'd, then completable the moment the replay was re-run with `tokenAddress` and
returned 200.

The only thing that closes the sale is a **successful replay of the task payment**.
The watcher's message currently offers a direct `POST /dossier` as the self-serve
route, which serves the buyer their document but leaves the task stuck, because a
direct call is not the task replay.

**Open question, not yet actioned:** reword the watcher's fallback message to tell
the buyer to re-run their task payment with the token address, rather than to call
the endpoint directly. That is buyer-facing copy, so it is left for a decision.

Job `0x2fa7c6` (buyer 4844) is in exactly this state right now: served over A2A,
recovery link verified working, but their task cannot complete until their own
client retries the replay. The "A. Confirm" option in their prompt does precisely
that, which is why the answer to it is A.

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

**Cleared 2026-07-28.** Agent 7012 is back to approvalDisplayStatus 4, "Listed, eligible for
task recommendations", statusLabel active. `www.okx.ai/agents/7012` returns 200 and the paid
route still answers 402. The outage from the description edit lasted under a day.

**Reopened and resolved the same day.** With the team's go-ahead, the service description and
the fee were both changed on 2026-07-28. Both went through in a single `agent update`, so the
listing pays only one review cycle rather than two.

The earlier "service in use, only name/description can be modified: 36013" wall was not a
pricing lock at all. It was the local A2A environment: `onchainos` gates every write behind
`okx-a2a doctor`, the daemon was not running and the CLI was a version behind, and the failure
surfaced as a confusing server-side message. Starting the daemon and upgrading to 0.1.10
cleared it, and the fee changed on the first attempt afterwards. Worth remembering: if a write
to the listing is refused for a reason that makes no sense, check `okx-a2a doctor` first.

Service 36013 kept its id, so the 12 sales and the 4.67 rating carried over. The listing is
back at approvalStatus 3 pending review, which is the expected cost of any edit.

### Do not leave a second A2A daemon running

Starting the local daemon to get the listing write through created a second actor for agent
7012, because **EC2 already runs one**. Both then spawned their own handler for the same job,
which on a real buyer's job would mean two agents answering in one channel. The local daemon
has been stopped and its autostart disabled.

The rule: EC2 is the only daemon that serves 7012. If a listing write from the laptop is
refused, start the local daemon, do the write, then stop it again:

```
okx-a2a daemon start && onchainos agent update ... && okx-a2a daemon stop
```

EC2's own daemon had no autostart and the `ubuntu` user had no systemd lingering, so a reboot
would have taken buyer A2A communication down silently while the HTTP endpoint stayed up.
Both are now enabled.

## 2. Rotate the OKX API credentials

They went through a chat transcript on 21 July and again on 27 July. The 21 July set was
dead by 27 July, which is plausibly why. Create a new key, verify, then delete the old one.

## 3. Verdict (#7008)

Removed from this repo and from the running service on 2026-07-27. The on-chain agent
record still exists and is not deactivated. Deactivating it is a separate, outward-facing
action; decide whether it is worth doing at all, since an inactive listing harms nothing.
