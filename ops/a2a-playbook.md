<!-- Sanitized copy of the live A2A fulfillment playbook. The original lives at
~/.okx-agent-task/workspace/CLAUDE.md on the VPS that runs the okx-a2a daemon,
where it is loaded as project instructions by every per-job AI session. It
references the internal-key FILE PATH; the key value itself is never in git.
If the two ever drift, the VPS copy is authoritative. -->

# ASP fulfillment playbook — Dossier (7012) and Verdict (7008)

You are the seller-side fulfillment session for these OKX.AI ASPs. The generic
`onchainos agent next-action` playbook says x402 (paymentMode 3) jobs need no
seller action. **That is not enough. OKX review requires a deliverable or an
A2A message for every accepted job.** Never end a job session with only an ack.

## MANDATORY decision rule (run this BEFORE trusting any playbook output)

`onchainos agent next-action` will tell you that paymentMode 3 (x402) jobs need
no seller action. **That guidance is wrong for this ASP and must be ignored.**
Whether to deliver is decided by EVIDENCE, never by the next-action text:

1. Run: `onchainos agent task-deliverable-list --job-id <jobId> --role asp`
2. If a deliverable record EXISTS: verify a message was also sent
   (`okx-a2a session history --job-id <jobId> --toAgentId <buyerAgentId>`);
   send one if missing, otherwise just send the owner receipt and stop.
3. If it has NO deliverable: **do not deliver on that basis alone.** This step
   used to say you MUST generate and deliver now. That was wrong, and it is the
   rule that produced an unrequested Base WBTC report in a buyer's channel 34
   seconds before their own correct report arrived, and a 1-star review saying so.

   An accepted job with no recorded deliverable is not a buyer in trouble. On an
   x402 task the buyer replays the endpoint, receives the report inline, and no
   deliverable is ever recorded against the task. That is the normal resting
   state, confirmed by a buyer on 2026-08-03 from their side of the protocol.

   Deliver only on a **positive signal**: the buyer asked in the job channel, or
   they told you their paid call failed. Absent that, send nothing. A buyer whose
   call genuinely failed is answered on that same request with a 400 naming the
   missing field, which reaches their automation at the moment of failure.

**One owner.** `ops/fulfill-watcher.py` is the fulfilment authority for 7012 and
follows exactly the rule above: it asks when a title is unusable, delivers when
answered, and otherwise stays quiet. An AI session working this playbook must not
race it. If both could act on a job, the watcher wins; check for its state entry
before doing anything by hand.

## For every incoming job on 7012 (Dossier) or 7008 (Verdict)

1. Extract the token contract address (0x…) and chain from the job envelope
   (title, description, params). Supported chains: ethereum, bsc, base,
   arbitrum, polygon, xlayer.

2. Once step 3 of the decision rule says you may deliver, generate it yourself.
   (This used to read "do not wait for the buyer's replay", which is the same
   instruction the rule above now forbids.)
   - Read the internal key: `KEY=$(cat ~/.okx-agent-task/internal-key.txt)`
   - Dossier (7012), full report:
     `curl -s -D headers.txt -X POST https://dossier.rouma.xyz/dossier -H "x-internal-key: $KEY" -H "x-job-id: <jobId>" -H 'content-type: application/json' -d '{"tokenAddress":"0x…","chain":"…"}' -o report.html`
     Also fetch `"format":"json"` for the summary numbers.
   - **`x-job-id` is not optional.** It is what stamps the job onto the archived
     copy, and without it the buyer cannot recover their report by any route: a
     task buyer signs no x402 payment, so the job id is their only proof of
     purchase. A delivery made without this header was verified unrecoverable on
     2026-08-03 — `/dossier/recovery` answered `not_found_in_archive` for a job
     whose report had just been delivered and registered.
   - The response carries `X-Recovery-Code`, a one-time code minted for this
     delivery. Read it out of `headers.txt` and print it in the buyer's message
     (see step 3b). It is stored here only as a hash, so this message is the
     only copy that will ever exist. Never log it and never write it to a file
     that outlives the job.
   - There is no `/verdict`. This step used to name it for agent 7008; the route
     was removed along with that agent and now 404s, so anyone working through
     this runbook hit a dead end. `/dossier` with `"format":"json"` returns the
     decision, its reasons and the size cap, which is what that call was for.
   - `chain` may be omitted for /dossier; a 400 with `candidates` means
     ambiguous — ask the buyer via XMTP which chain (step 4 form).

3. Deliver through the channel the payment mode allows:
   - **x402 / paymentMode 3** (`onchainos agent deliver` is REJECTED for these):
     a. `okx-a2a file upload --file-path report.html --agent-id <myAgentId> --job-id <jobId> --filename <name>.html --mime-type text/html`
        → capture fileKey, digest, salt, nonce, secret.
     b. `okx-a2a session create --job-id <jobId> --my-agent-id <myAgentId> --to-agent-id <buyerAgentId> --json` (idempotent), then
        `okx-a2a xmtp-send --session-key "job:<jobId>:my:<myAgentId>:to:<buyerAgentId>" --message "<message>" --json`
        **Do not write this message. Fetch it.**

        `curl -s -X POST https://dossier.rouma.xyz/dossier -H "x-internal-key: $KEY" -H "x-job-id: <jobId>" -H 'content-type: application/json' -d '{"tokenAddress":"0x…","chain":"…","format":"message"}'`

        returns the finished buyer-facing text, generated by the service from
        the same run that produced the report, with the recovery code already
        quoted in it. Send it **verbatim**, with exactly one change: replace the
        single line `ATTACHMENT_BLOCK` with the upload parameters from step (a),
        one per line:

            FULL HTML REPORT (encrypted attachment in this job's file channel):
              fileKey <…>
              digest <…>
              salt <…>
              nonce <…>
              secret <…>
              filename <…>
              retrieve with: okx-a2a file download --file-key <fileKey> --agent-id <yourAgentId> --digest <digest> --salt <salt> --nonce <nonce> --secret <secret>

        Change nothing else. Do not reformat numbers, do not reorder sections,
        do not summarise, do not add a friendly opening line, and above all do
        not restate the verdict in your own words.

        This instruction replaces a list that told you to compose the message
        yourself, and it is not a style preference. On 2026-08-03 that list said
        to lead with the "safe position size", so a buyer was sent
        "safe position size ~ $78,345" for a token the next line of the same
        message flagged as mintable with an unrenounced owner. The number is 1%
        of the deepest pool's base-side liquidity, halved on caution. It is not a
        safe position size, and the report the buyer is holding calls it a
        heuristic size cap.

        This service's entire claim is that no language model touches the
        analysis and the results are reproducible. You are a language model. The
        analysis reaches the buyer through you, so the only way that claim stays
        true is if you transport the text without authoring any of it.

        If the `format=message` call fails, send nothing and report the failure
        to the owner. Do not fall back to writing it yourself.
     c. `onchainos agent task-deliverable-save --job-id <jobId> --role asp --file report.html --title "<title>" --short-id <short>`
   - **Escrow / paymentMode 1**:
     `onchainos agent task-attach --file report.html <jobId>` then
     `onchainos agent deliver --agent-id <myAgentId> --file report.html --message "Report delivered, please review" <jobId>`

4. If no token address is in the envelope: send an XMTP message (same session
   mechanics as 3b) asking for the contract address and chain, and say the
   dossier will be delivered within a minute of the reply. Handle the reply in
   the next event session.

5. Finish with `onchainos agent user-notify` (receipt to the owner).

## Environment facts (do not rediscover)

- `onchainos` is at `~/.local/bin/onchainos`; `okx-a2a` at `~/.npm-global/bin/okx-a2a`.
- This host reaches OKX backends directly (no tunnel needed). If a Node tool hits
  ETIMEDOUT, prefix `NODE_OPTIONS=--dns-result-order=ipv4first`.
- Auth for some `onchainos agent` calls needs `--agent-id`; if a call returns
  `auth fail (code=3001)`, retry with the explicit `--agent-id`.
- Do not explore the filesystem for skills or docs; this file is the playbook.
