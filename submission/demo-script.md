# Demo video — Dossier

Updated 2026-07-27. **The videos are already produced.** This file is no longer a shot
list to film; it is the record of what exists and what is left to do.

## What exists

Both are 1920x1080, 30fps, exactly 90.00 seconds, **silent**, in `~/Downloads`:

| File | Style | Notes |
|---|---|---|
| `dossier-demo-screencast-90s.mp4` | Live product screencast | **Recommended.** Matches the pattern of the reference demo: full-screen browser, real pages scrolling, a real terminal session, ending on our OKX.AI listing showing ★5.0 and the reviews. 5.9 MB |
| `dossier-demo-90s.mp4` | Designed deck | Slide-style with the same real data. 11.1 MB |

Voice-over scripts, timed to each cut, also in `~/Downloads`:

- `dossier-screencast-voiceover.md` — for the screencast cut, ~180 words
- `dossier-demo-voiceover.md` — for the deck cut, ~215 words

## What is left

1. Record the voice-over against the screencast cut. About 20 minutes.
2. Mix it under the video. There is no audio track to replace; both files are silent.
3. Upload, then paste the link into `form-answers.md` and the submission post.

## Everything on screen is real

Nothing was mocked. The recording used a live purchase: transaction
`0xdb8086ddf2dfeb2aa8c86ef7cb4b17e82a1f11272765d95186ead276d57f25a8`, 0.50 USD₮0 settled
on X Layer, and the report shown is the document that came back from that payment. The
recovery hashes shown are the real sha256 of the paid bytes and the recovered bytes. The
listing page at the end is our actual OKX.AI page.

## Screencast beat map

| Time | On screen |
|---|---|
| 0:00 – 0:11.6 | Live hero, six real animation states |
| 0:11.6 – 0:24.2 | Landing page scrolling: what one call returns, the curl example |
| 0:24.2 – 0:39.8 | The free sample report, scrolling |
| 0:39.8 – 1:06.4 | Terminal: preflight, quote, pay, recovery |
| 1:06.4 – 1:30 | OKX.AI listing: stats, service, reviews |

## Recording notes

- 48kHz mono. Start the first word at 0:05; the opening silence is deliberate and matches
  the reference demo.
- Say "USDT-zero" and read the agent id as "seven zero one two".
- Do not film a live purchase yourself unless the credentials are known good on the day.
  The cut already contains one.

## If you re-cut it

The generators are throwaway but reproducible: they read captured artifacts and rebuild
the video with ffmpeg. Swapping the token or reordering scenes is a small edit and a
two-minute rebuild. They were left in the session scratchpad rather than the repo, because
a video build pipeline is not something this service should carry.

## One thing to know before recording

The sample report on screen says **caution**, not proceed, because GoPlus does not report
CAKE's trading taxes and the contract is mintable by an active owner. That was chosen
deliberately. A due-diligence tool that says "caution, and here is exactly why" argues its
own case better than one where everything is green.
