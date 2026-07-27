# Demo video — Dossier

Updated 2026-07-27 (evening). **The narrated video is finished.** Nothing is left to
record; this file records what exists and how it was made.

## The deliverable

`dossier-demo-narrated-90s.mp4` in `~/Downloads`. 1920x1080, 30fps, exactly 90.00s,
**with narration already mixed in** (AAC, 48kHz stereo, normalised to -16 LUFS).

Narration is a neural voice, `en-GB-RyanNeural` at -4% rate, generated line by line and
placed on its own cue so the pauses land where the picture changes. That matches how the
reference demo was paced.

## Beat map and narration cues

| Time | On screen | Narration |
|---|---|---|
| 0:00 | Live hero, six real animation states | silence until 0:04 |
| 0:04 | | "Dossier is a due diligence agent on OKX dot AI…" |
| 0:10.4 | Landing page scrolling | |
| 0:12.9 | | "A verdict, five checks each with its reason…" |
| 0:22.0 | The paid report, scrolling | |
| 0:22.6 | | "A real report. It reads the chain directly…" |
| 0:34.2 | | "Where a source had nothing, it says so…" |
| 0:38.1 | Terminal: preflight, quote, pay, sources | |
| 0:40.0 | | "Here is a buyer. A free preflight first…" |
| 0:47.9 | | "Then the x402 challenge. It carries the required inputs…" |
| 0:57.0 | | "Fifty cents on X Layer. Settlement happens only on success…" |
| 1:00.2 | The verifier, showing PASS / PASS | |
| 1:05.4 | | "Every report is signed…" |
| 1:11.8 | | "Check it yourself, in your browser…" |
| 1:14.8 | OKX.AI listing: stats, service, reviews | |
| 1:21.2 | | "Dossier. Live on OKX dot AI as agent seven zero one two." |

## Everything on screen is real

Captured from production on the day. The purchase shown is transaction
`0x8e2803f12590bd3df1ee76d5cb70101f373f4b95ec17757ed634d8ecc2fb39a6`, 0.50 USD₮0 settled
on X Layer. The verification segment is that same report, opened through a real
`/verify?attestation=…` link, showing both checks passing. The listing at the end is our
actual OKX.AI page.

## Earlier cuts, superseded

`dossier-demo-screencast-90s.mp4` and `dossier-demo-90s.mp4` are from earlier in the day
and now show a landing page that no longer exists, with no verifier and no signed reports.
Do not submit them.

## If you want it re-voiced

The generator takes environment overrides, so a different voice is one line:

```
VOICE=en-US-AndrewNeural RATE=-2% python3 voice.py
```

It refuses to build if any line overruns its slot, and prints the gap it measured for
each, so a re-voice cannot quietly collide with a scene change.

## One thing to know

The report on screen says **caution**, not proceed, because GoPlus does not report CAKE's
trading taxes and the contract is mintable by an active owner. That was chosen
deliberately: a due-diligence tool that says "caution, and here is exactly why" argues its
own case better than one where everything is green.
