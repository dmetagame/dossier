# Submission record

The audit of 2026-08-04 called this the most important non-code gap, and it is
right: the listing being live proves the product exists, not that the entry was
submitted. Nothing in this repository currently proves the final step happened.

**This file is deliberately unfinished.** Every blank below needs a real value
from the person who performs the action. Do not fill any of them in from memory,
and do not treat a plausible reconstruction as a record — the whole point is that
it is checkable by someone who was not there.

## Required

| Item | Value | Status |
|---|---|---|
| X post URL | | **outstanding** |
| X post contains `#OKXAI` | | **outstanding** |
| X post published at (UTC) | | **outstanding** |
| Demo video public URL | | **outstanding** |
| Demo length (must be ≤ 90s) | 90.00s | ✅ verified |
| Google Form submitted at (UTC) | | **outstanding** |
| Google Form confirmation (screenshot path or confirmation id) | | **outstanding** |

## Already verifiable, no action needed

| Item | Value |
|---|---|
| Listing | https://www.okx.ai/agents/7012 |
| Listing status | Listed, eligible for task recommendations, online |
| Endpoint | https://dossier.rouma.xyz/dossier |
| Price | 0.01 USD₮0 per call, x402 on X Layer (`eip155:196`) |
| Marketplace record (2026-08-04) | ★4.5, 83.33% positive, 28 sold, 6 reviews |
| External revenue | 11 tasks, 6 distinct buyers, 4.03 USD₮0 — see `revenue-ledger.md` |
| Demo file SHA-256 | `fa562bc30b772ab42ba10b78f90ab8a4807bd17c01e431fb62ae48e826eb4b4c` |

## Known defect in the submitted demo

The narration says "Fifty cents on X Layer" and the on-screen purchase settles
0.50 USD₮0. The live price has been 0.01 since 2026-07-28.

The decision recorded in `demo-script.md` is to leave it: the flow, challenge,
signature check and listing are all still accurate, and the error is in the
direction of quoting a *higher* price than we charge, so no viewer is misled into
expecting a better deal than exists. Re-cut it only if the submission reopens for
another reason. If a judge raises it, the honest answer is that the price was
reduced after recording and the video was not re-rendered.

## The reviews, if asked

The public listing carries a review saying a follow-up "requested a second
payment based on a false claim". A judge will see it and is unlikely to dig
further, so the context belongs here in one paragraph rather than in the demo:

> Dossier charges once, per call, over x402. The report itself contains no
> payment-demand text and never has. The complaint refers to an automated
> follow-up message in the marketplace job channel, which on 2026-08-02 told
> buyers to "re-run your x402 task payment" — including buyers whose payment had
> already settled, for whom it was simply false. That message was ours, it was
> wrong, and it was removed the same day. The delivery text is now generated
> deterministically by the service rather than composed per-delivery, and it
> carries the line "You owe nothing further for this report. This message never
> asks for payment", which is asserted by a test that fails if it disappears. A
> later review on the same listing corrects the original complaint and
> attributes it to the buyer's own automation.

Do not lead with this and do not put it in the demo. It answers a question if
asked; raising it unprompted turns a resolved incident into the story.
