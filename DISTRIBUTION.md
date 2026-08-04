# Distribution & community plan — OKX.AI Genesis (deadline 2026-07-27)

This plan gets the same status as the code. The diagnosed loss pattern is: great build,
invisible entry. Rules of engagement: **no self-paid volume, no wash usage, no fake traction.**
Free first call per wallet is the honest acquisition hook; only third-party paid calls get
claimed as traction.

## Channels (join on day 1, not submission day)

| Channel | Purpose |
|---|---|
| X Layer Builder Hub Telegram | live support + visibility with the X Layer team |
| HackQuest Genesis hackathon community (Discord/page comments) | be a recognizable name to organizers before review |
| X (Twitter) with #OKXAI | build-in-public thread — the submission post should be the *last* post of a visible week, not the first |
| okx/onchainos-skills + okx/agent-skills GitHub | issues/discussions — agent devs who already build with OKX skills are the exact buyer |

## Cadence (Jul 18 → 27)

- **Jul 18** ✅ scaffold live locally: 402 challenge + live-data verdicts working.
- **Jul 19** — eligibility confirmed (user, via phone/VPN). Join Telegram + HackQuest community.
  First #OKXAI post: the problem ("agents ape; scanners dump flags; nobody sizes the trade") + what's coming.
- **Jul 20** — deploy to prod URL, wire facilitator verification, X Layer data via OKX API from deployed env.
  Post: 20-second clip of 402 → pay → verdict flow.
- **Jul 21** — register ASP + submit service listing (**review buffer starts here — this date is the deadline that matters**).
  Run the benchmark: ~10 known rugs + ~10 established tokens; post the accuracy table with #OKXAI.
- **Jul 22–23** — first-users push (list below). Free first call. Fix whatever review bounces.
- **Jul 24** — record the 90-second demo (script below). Draft the Google-form answers.
- **Jul 25** — submit: X submission post + form. Two-day buffer is deliberate.
- **Jul 26–27** — reserve for review round-trips only. No new features.

## First-users list (10 pings, personal, not broadcast)

1–4. Hackathon-circuit agent builders we already know (Somnia Agentathon, BNB HACK, Lepton/Canteen
     Discord contacts) — they run agents that transact and can wire one HTTP call in minutes.
5–7. Active contributors/issue-openers on okx/onchainos-skills and okx/agent-skills GitHub.
8.   X Layer Builder Hub TG: ask who's building trading/portfolio agents, offer integration help live.
9–10. Authors of Build X agent-edition entries (submissions closed 07-17 — they have live agents on
     X Layer *right now* and nothing to build; adding a risk gate is a 10-minute integration).

Pitch line: "One POST before your agent trades. It answers: proceed or not, and up to how much. First call free, 0.2 USDT after."

## 90-second demo script

1. (0–15s) An agent is told to buy $500 of a random hyped token. Show the raw scanner output: LP locked ✓, not a honeypot ✓ — looks fine.
2. (15–45s) Same token through Verdict: `caution, maxSizeUsd: 68, "24h volume $2 — near-dead market"`. The agent buys $68 instead of $500 — or skips.
3. (45–70s) The x402 moment: show the 402 challenge, the agent paying 0.2 USDT on X Layer, the receipt. "The agent paid for this answer autonomously."
4. (70–90s) Benchmark table (rugs caught / blue chips passed), OKX.AI listing card, price, endpoint. Tag #OKXAI.

## Submission assets checklist (drafted by Jul 24, not Jul 27)

> **The evidence for these lives in `submission/submission-record.md`**, which
> records how each one was checked rather than only that it was done.

- [x] X submission post — https://x.com/Herboobakar/status/2081858337553973363
      (verified: #OKXAI present, media attached, published 27 July 2026)
- [x] Google form answers — submitted; stated by the owner, no artifact recorded
- [ ] Listing copy that survives OKX QA: two-part description, no GitHub links, no tech-stack words, no disclaimers, ≤400 chars
