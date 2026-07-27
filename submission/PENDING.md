# Pending decisions

## 1. The listing copy still says "safe position size"

**Status: parked deliberately on 2026-07-27. Not forgotten, not done.**

Everything we control now says "heuristic size cap": the report itself, the landing page,
the README, `/info`, and the engine's own reason string. The only place the old claim
survives is OKX's stored listing copy, in both the agent description and the service
description.

**Why it is not fixed yet.** Editing it means `onchainos agent update`, and the CLI states
that QA runs at register and update. Agent 7012 currently sits at approvalDisplayStatus 4,
"Listed, eligible for task recommendations", with ★5.0 and 10 sold. An edit sends it back
through review, for an unknown period, and it was rejected twice before it was approved.
That is a real cost against a copy inconsistency.

**The replacement text, ready to paste** (agent description, under 500 chars):

> Dossier transforms a single request into a polished, executive-ready due diligence report
> for any token. It consolidates live security, market and holder data, plus direct reads
> from the chain itself, into one shareable document: a clear risk assessment, a heuristic
> position-size cap with its formula stated, and the key findings at the top. Every report
> is signed, so a buyer can verify it independently. Instead of piecing together multiple
> dashboards, an agent or analyst receives a complete report in one call.

**Service description part 1:**

> Generates a complete, formatted due diligence report on a token for an agent or analyst.
> The report includes a risk assessment, a heuristic position-size cap, security alerts,
> liquidity, market activity, holder concentration, and the contract's on-chain identity,
> all compiled into a single shareable document. Every report carries a signature the buyer
> can verify independently. The final report is delivered directly in the paid response.

**Service description part 2** (unchanged):

> 1. Token contract address 2. Optional: chain name, auto-detected when unambiguous
> 3. Optional: output format, either report or data

**When to do it.** After judging, or whenever a spell in the review queue is acceptable.
The listing is much stronger than when it was rejected: signed reports, a public verifier,
a free preflight, direct chain reads, and an independent five-star review.

**Note:** the fee field is locked while the service is in use, so this is a description-only
edit either way.

## 2. Rotate the OKX API credentials

They went through a chat transcript on 21 July and again on 27 July. The 21 July set was
dead by 27 July, which is plausibly why. Create a new key, verify, then delete the old one.

## 3. Verdict (#7008)

Removed from this repo and from the running service on 2026-07-27. The on-chain agent
record still exists and is not deactivated. Deactivating it is a separate, outward-facing
action; decide whether it is worth doing at all, since an inactive listing harms nothing.
