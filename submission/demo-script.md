# 90-second demo script — Dossier (primary, OKX.AI Genesis, Track #1)

Goal: show a single paid call turning into a finished, shareable business asset.
Record screen at 1280x720+, no dead air. Keep it under 90 seconds.

## Shot list

**0:00–0:12 — the problem**
On camera / voiceover over a messy screen with 4 tabs open (a scanner, a DEX chart, a
holders page, a block explorer):
"To vet one token you're stitching together four dashboards. An agent can't do that.
It needs one call that returns a finished report."

**0:12–0:30 — the call**
Terminal. Show the request, one input only:
`curl -X POST https://dossier.rouma.xyz/dossier -d '{"tokenAddress":"0x..."}'`
Say: "One input. It even finds the chain itself." First response is HTTP 402. "It's a
paid service. First call returns a payment challenge, priced in USD₮0 on X Layer,
standard x402."

**0:30–0:50 — payment + delivery**
Show the agent paying and the request replaying (OKX SDK / a wallet with USD₮0). The
response is the report. Cut to the rendered HTML dossier in a browser:
"One call, one finished document — risk verdict up top, safe position size, security
flags, liquidity, holders, all from live data."

**0:50–1:10 — the asset**
Scroll the report slowly: the verdict badge, the snapshot grid, the risk-check table,
key findings, contract & distribution. Then hit Print → Save as PDF to show it's a real,
shareable file. "It's an executive-ready asset an agent produced autonomously and
got paid for."

**1:10–1:20 — the marketplace + close**
Show the OKX.AI listing card for Dossier (agent #7012). Say: "Dossier is live on OKX.AI.
Agents pay per call on X Layer and get back a report they'd otherwise spend an hour
compiling." End card: name, endpoint, #OKXAI. Hard stop by 1:20 — the rule is max 90
seconds and trimming or upload re-encoding must never push past it.

## Notes
- If the wallet isn't funded with USD₮0, use the `format:"json"` path or the OKX
  `payment quote` output to show the payment step, then show a pre-generated report.
- Funding ~$2 of USD₮0 on X Layer to the payout wallet lets you show a real settle —
  much stronger. Do this before recording if time allows.
