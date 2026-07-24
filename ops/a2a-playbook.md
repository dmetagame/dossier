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
2. If it has NO deliverable for this job: you MUST generate and deliver now
   (steps below). "The endpoint already returned it" is not evidence — the
   buyer's replay may have failed; only the deliverable record counts.
3. If a deliverable record EXISTS: verify a message was also sent
   (`okx-a2a session history --job-id <jobId> --toAgentId <buyerAgentId>`);
   send one if missing, otherwise just send the owner receipt and stop.

## For every incoming job on 7012 (Dossier) or 7008 (Verdict)

1. Extract the token contract address (0x…) and chain from the job envelope
   (title, description, params). Supported chains: ethereum, bsc, base,
   arbitrum, polygon, xlayer.

2. Generate the deliverable yourself (do not wait for the buyer's replay):
   - Read the internal key: `KEY=$(cat ~/.okx-agent-task/internal-key.txt)`
   - Dossier (7012), full report:
     `curl -s -X POST https://verdict-pi.vercel.app/dossier -H "x-internal-key: $KEY" -H 'content-type: application/json' -d '{"tokenAddress":"0x…","chain":"…"}' -o report.html`
     Also fetch `"format":"json"` for the summary numbers.
   - Verdict (7008), decision JSON:
     `curl -s -X POST https://verdict-pi.vercel.app/verdict -H "x-internal-key: $KEY" -H 'content-type: application/json' -d '{"chain":"…","tokenAddress":"0x…"}'`
   - `chain` may be omitted for /dossier; a 400 with `candidates` means
     ambiguous — ask the buyer via XMTP which chain (step 4 form).

3. Deliver through the channel the payment mode allows:
   - **x402 / paymentMode 3** (`onchainos agent deliver` is REJECTED for these):
     a. `okx-a2a file upload --file-path report.html --agent-id <myAgentId> --job-id <jobId> --filename <name>.html --mime-type text/html`
        → capture fileKey, digest, salt, nonce, secret.
     b. `okx-a2a session create --job-id <jobId> --my-agent-id <myAgentId> --to-agent-id <buyerAgentId> --json` (idempotent), then
        `okx-a2a xmtp-send --session-key "job:<jobId>:my:<myAgentId>:to:<buyerAgentId>" --message "<summary + ALL attachment params (fileKey/digest/salt/nonce/secret/filename) + exact x402 replay body>" --json`
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
