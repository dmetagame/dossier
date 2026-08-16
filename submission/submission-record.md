# Submission record

This is a dated submission snapshot, not a claim about the current marketplace state.
On 2026-08-15 OKX delisted agent 7012 after a paid response was withheld, and the
corrected service description was resubmitted. The current state is **Listing under
review**; see [listing.md](listing.md) for the remediation evidence.

The audit of 2026-08-04 called this the most important non-code gap, and it was
right: the listing being live proves the product exists, not that the entry was
submitted.

Filled in 2026-08-04. Each row below says how it was checked, because "the owner
told me" and "an independent endpoint returned it" are different kinds of
evidence and the difference is the whole point of this file.

## Required

| Item | Value | How it was checked |
|---|---|---|
| X post URL | https://x.com/Herboobakar/status/2081858337553973363 | ✅ verified via X's own oembed endpoint |
| X post author | Rouma (@Herboobakar) | ✅ same |
| X post published | 27 July 2026 | ✅ same |
| X post contains `#OKXAI` | yes, as a linked hashtag | ✅ same, present in the returned markup |
| X post has media attached | yes (`pic.twitter.com/tGlup8jXya`) | ✅ same |
| Demo video public URL | https://youtu.be/6Uq1ZCxPQ2o | ✅ verified via YouTube oembed, HTTP 200 |
| Demo video title / channel | "dossier demo" / Issa Abubakar | ✅ same |
| Demo length (must be ≤ 90s) | 90.00s in the source file | ⚠️ verified on the local master, not on the upload — oembed returns no duration |
| Uploaded video is the same cut as the local master | | ⚠️ **not verifiable from here.** A YouTube stream cannot be hashed against `fa562bc3…` |
| Google Form submitted | yes | ⚠️ **stated by the owner, no artifact.** See below |

### The form submission has no artifact

The owner states the form was submitted. There is no confirmation id, timestamp
or screenshot recorded, so this row rests on their word rather than on anything a
third party could check.

That is very probably fine — it is their submission and they performed it. It is
recorded this way rather than ticked because the entire reason this file exists
is that the previous audit could not tell a completed step from an assumed one.
If a confirmation email or screenshot still exists, adding its timestamp here
closes the last gap in the entry.

## Already verifiable, no action needed

| Item | Value |
|---|---|
| Listing | https://www.okx.ai/agents/7012 |
| Listing status at snapshot time | Listed, eligible for task recommendations, online |
| Endpoint | https://dossier.rouma.xyz/dossier |
| Price | 0.01 USD₮0 per call, x402 on X Layer (`eip155:196`) |
| Marketplace record (2026-08-05) | ★4.33, 29 sold, 7 reviews |
| External revenue | 12 tasks, 6 distinct buyers, 4.04 USD₮0 — see `revenue-ledger.md` |
| Demo file SHA-256 | `fa562bc30b772ab42ba10b78f90ab8a4807bd17c01e431fb62ae48e826eb4b4c` |

## The X post quotes the old price

The post says **"0.5 USD₮0 per call over x402 on X Layer"**. It was published on
27 July; the price dropped to 0.01 on 28 July, the day after. The live listing,
the challenge, `/info` and this repository all say 0.01.

Same shape as the demo narration and the same direction of error: it quotes a
price *higher* than we charge, so no reader is misled into expecting a better
deal than exists. The difference is that a post can be corrected additively with
a short reply, where the video would have to be re-rendered and re-uploaded.

**Owner's decision required.** A one-line reply — "Price is now 0.01 USD₮0 per
call, down from the 0.5 quoted above" — costs nothing, is visible to anyone who
reads the thread, and does not alter the submitted post. Doing nothing is also
defensible. What would not be defensible is repeating the 0.5 figure anywhere
new.

Everything else in the post still holds: the refusal to guess, settlement only on
success, the free preflight, and the signed report are all still exactly true.

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

## The 3.5-star review of 2026-08-05

Buyer #4844 left ★3.5: *"Delivered, no upsell this time; but report labeled base
not ethereum, LP-lock metric misfits WBTC."* Both complaints were real and both
are fixed. If a judge asks:

> The wrong chain was two defects with one symptom. The fulfilment watcher
> resolved a bare "WBTC" through DexScreener's search, which returns only a small
> Base deployment and omits Ethereum's entirely, and a single search result never
> tripped the ambiguity check — so it went out with full confidence. It also
> pushed that report into the buyer's channel unrequested, 34 seconds before
> their own correct Ethereum report arrived. Majors now resolve from a canonical
> table verified against `symbol()` on-chain, and a delivery requires that the
> buyer asked for one. Both landed on 2026-08-02, roughly two hours after the
> report being reviewed was generated.
>
> The LP-lock complaint was the sharper one. GoPlus marks `is_locked` on lockers
> it recognises among the top LP holders of a single pool, so finding none came
> back as 0, and the report printed "0% of LP locked" as though it were a
> measurement. It read 0 for WBTC, LINK and PEPE alike, and under $1M it
> downgraded the token: a bridged blue chip with a $790k pool came back "caution,
> liquidity can be pulled" capped at $1.1k. A lock is now reported when one is
> found and nothing is claimed when one is not.

The second complaint is the one worth volunteering, because it is the failure
this product exists to refuse: an absence of evidence printed as evidence of
absence. It was caught by a buyer rather than by us, and the check had been
wrong for every token it ever ran on.

The same buyer purchased again 40 minutes after leaving that review and rated the
service 100.
