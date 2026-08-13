# Dossier

One paid call turns a token address into a polished, executive-ready due-diligence
report. Live on OKX.AI as an A2MCP service (agent #7012) at
`https://dossier.rouma.xyz/dossier`, paid per call over x402 on X Layer.

An agent or analyst sends a token address; Dossier returns a **finished document**,
not a data dump: risk verdict up top, a heuristic size cap, security flags, liquidity,
market activity, and holder distribution, compiled deterministically from live
GoPlus + DexScreener data and rendered as a self-contained HTML report that reads,
shares, and prints to PDF. `format: "json"` returns the same content as structured data.

Free sample of a real generated report: https://dossier.rouma.xyz/dossier/sample

## Endpoints

| Route | Method | Price | What it does |
|---|---|---|---|
| `/dossier` | GET, POST | 0.01 USD₮0 | Full due-diligence report (`html` default or `json`) |
| `/dossier/recovery` | GET, POST | free | Re-fetch a report you already paid for: `paymentTransaction` alone, or `jobId` **with** `recoveryCode` |
| `/dossier/preflight` | GET, POST | free | Coverage check for a token before you pay |
| `/dossier/sample` | GET | free | Real sample report, cached |
| `/` | GET | free | Landing page |
| `/info` | GET | free | Machine-readable service description |
| `/health` | GET | free | Status, including whether the payment layer is actually up |
| `/verify` | GET | free | Browser-side attestation checker; runs locally, no wallet or account |
| `/.well-known/dossier-signing-key.json` | GET | free | The Ed25519 public key reports are signed with |
| `/avatar.png` | GET | free | Listing image, served from our own origin |
| `/f/:file` | GET | free | Self-hosted webfonts for the landing page, content-hashed |

A job id is not sufficient on its own for `/dossier/recovery`: job ids are publicly
enumerable through the marketplace, so current deliveries require the random recovery
code printed in the buyer's delivery message. Legacy records that predate recovery
codes still use the original request as their second check. A settlement transaction
needs nothing else, although it is observable on-chain and is not a confidentiality
boundary.

Parameters: `{"tokenAddress": "0x…", "chain": "…", "format": "html|json"}`. They may be
sent as a JSON body or as query-string parameters, on either method — buyers' x402
clients replay differently and OKX's own `payment quote` defaults to GET, so a
POST-body-only service would answer a paying caller with 400.

`chain` is optional. It is auto-detected from live markets; when an address is deployed
on several chains the deepest-liquidity deployment is analysed and the report states
which chain it used and what the alternatives were.

## Knowing what you get before you pay

The payment challenge carries the input contract, so a cold agent can discover
the required fields before authorising payment:

```
extensions.outputSchema.input = { type: "http", method: "POST",
  contentType: "application/json", schema: { required: ["tokenAddress"], … } }
```

It lives in `extensions` rather than in the `accepts` entries on purpose. Those
are what the client signs over, and an extra field there risks a verification
mismatch at the facilitator.

Coverage is a separate question from inputs: a token with no DEX pool has no
price, liquidity, volume, or size cap, whatever the request looks like. Ask
first, free:

```bash
curl "https://dossier.rouma.xyz/dossier/preflight?tokenAddress=0x…&chain=(optional)"
```

It returns the resolved token and chain, which sources hold it, the expected
coverage, the exact fields the report will and will not contain, and whether it
can be produced at all. Coverage comes from the same engine that writes the
report, so the preflight cannot promise a number the paid deliverable then
contradicts. It deliberately withholds the verdict, the reasons, the size cap
and every security flag: it tells you whether the report is worth buying, not
what it says.

When neither source has a record of an address, the paid endpoint answers 404
and takes no payment. Settlement only happens on a 2xx, so a token nothing has
heard of cannot be charged for.

## Recovery

A paid response can be lost for reasons unrelated to this service: the client crashes,
the connection drops after settlement, the file is overwritten. Every delivered report
is archived and can be re-fetched. The 90-day/5000-record pruning policy currently
applies only to records that have no durable transaction, job, or replay ownership; x402 reports and their
payment-replay ownership state are retained indefinitely so a pruned proof can never be
reassigned. A compact permanent-tombstone design is still needed before those records
can be safely bounded. Pending or unknown settlement attempts publish an authenticated,
report-indexed replay hold before settlement can begin; pruning and hold publication use
the same cross-process record lock, so staged reports remain available for reconciliation
beyond the ordinary retention window. Definite-unpaid cleanup removes the hold only after
the replay attempt has been durably released.

```bash
# paid over x402: the settlement hash is enough on its own
curl "https://dossier.rouma.xyz/dossier/recovery?paymentTransaction=0x…"

# bought as a marketplace task: a job id is not proof of purchase on its own,
# because job ids are publicly enumerable, so send the code from your delivery
# message with it
curl -X POST https://dossier.rouma.xyz/dossier/recovery \
  -H 'content-type: application/json' \
  -d '{"jobId":"0x…","recoveryCode":"…"}'
```

It returns the archived bytes, identical to what was delivered, with the request,
delivery timestamp, and settlement transaction or job id attached.

Recovery **requires one of those two proofs**. The second factor for a job id used to
be the request itself, and that was too weak: `WBTC on ethereum` is what most buyers of
a WBTC report sent, so an enumerated job id paired with the obvious request read a
report nobody had bought. Each task delivery now mints a random 128-bit code, returned
to the fulfilment daemon in a response header and printed once in the buyer's delivery
message. Only its SHA-256 is stored, so reading the archive does not yield it, and the
code never enters the report, which is signed and archived. Records written before this
keep the parameter check while those legacy records remain in the archive.

The settlement transaction stays sufficient on its own, deliberately. Transfers to the
payout address are visible on-chain, so an observer who watches them can reach a report,
and the recovery response says so in a `confidentiality` field rather than leaving it to
this file. Requiring a code there would be worse than the leak: the code travels in the
response, and a buyer who still holds the response does not need recovery at all. The
transaction hash is what survives losing it. Either the chain you sent or the chain the
report resolved will do, since a buyer who omitted it holds a report naming the resolved
one.

The job id exists because a task-level buyer never signs an x402 payment: our fulfilment
daemon delivers their report into the job channel, so there is no settlement transaction
to key recovery on, and without this they were the one class of buyer who could not
re-fetch. The daemon stamps the job id on the copy it sends, and the service accepts that
header only from the daemon — otherwise a buyer could stamp someone else's job id onto
their own record and shadow the real deliverable.

Neither proof is a secret in the cryptographic sense: a determined observer could read a
transfer to the payout address off-chain. This is a guard against casual free reports,
not a confidentiality boundary, and it is proportionate — the reports are built from free
public data, a full sample is published, and an attacker only ever reaches a report on a
token somebody else chose.

Each delivery is archived under its own id, so two buyers asking about the same token
cannot evict each other's record. A job delivered more than once resolves to the most
recent copy, which is the one the buyer actually received.

## Payment (x402 v2)

An unpaid GET, POST, or HEAD returns `402` with a base64 `PAYMENT-REQUIRED` challenge
(`exact` scheme, `eip155:196`, USD₮0, `maxTimeoutSeconds` 300). The OKX server SDK
(`@okxweb3/x402-hono` + `OKXFacilitatorClient`) builds the challenge and performs
verify/settle; settlement is attempted only after the report is durably archived and
the handler returns 2xx. Input, data-source, and report-generation failures are therefore
not charged. A failure after settlement was attempted can instead be `charged: "unknown"`
or `charged: "confirmed"`; in that case retry the exact same signed payment and never
authorize a new one. Verified end to end with a settled on-chain
purchase (X Layer tx `0xbb6e4399…19e6c`).

Design guarantees:
- **Fail closed**: missing facilitator credentials in production → paid routes 503,
  never silently free.
- **No charged errors**: bad input, unknown chains, ambiguous addresses, and data-source
  outages all return non-2xx (unpaid).
- **Replay-safe delivery**: the staged report is attached to authenticated durable replay
  state before settlement can begin. A finalized retry returns the exact archived bytes;
  the same payment with a different request returns 409 and never settles again.
- **Honest unknown outcomes**: an unreachable or contradictory settlement returns 503,
  retains the staged report for reconciliation, includes a stable `reconciliationId`, and
  tells the buyer to retry only the same signed payment.
- **Cold-start hardening**: first-request facilitator sync failures retry once,
  provably without re-running a handler.

## Engine

Five deterministic checks — sellability/honeypot, contract control, liquidity depth,
market activity, holder concentration — with tri-state source handling (`ok` /
`not_found` / `unavailable`: an API outage is never treated as knowledge about the
token). Verdict is `proceed`/`caution`/`abort` plus `maxSizeUsd` (capped at 1% of
pooled base-side liquidity, halved on caution) and a data-coverage confidence score.
No LLM anywhere: results are reproducible and benchmarkable.

## Run locally

```bash
pnpm install
NODE_OPTIONS=--dns-result-order=ipv4first DEV_SKIP_PAYMENT=1 pnpm dev
curl -X POST localhost:8787/dossier -H 'content-type: application/json' \
  -d '{"tokenAddress":"0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"}'
```

`DEV_SKIP_PAYMENT=1` unmounts the payment middleware for local testing; production
requires the env vars in `.env.example` (set on the deploy host, never committed).

## Test

```bash
pnpm test          # the Node suite, no network
pnpm test:browser  # /verify in real chromium (needs `pnpm exec playwright install chromium`)
python3 -W error::ResourceWarning -m unittest discover -s ops -p 'test_*.py'   # the watcher
pnpm typecheck
```

The suite replays upstream responses recorded in `test/fixtures/upstream.json`,
and the stub **throws on any request the fixtures do not cover**, so a test can
never quietly start depending on live data and then fail because a token's
liquidity moved. Re-record deliberately with `node test/capture-fixtures.mjs`.

What it holds the service to:

- **Determinism** — the same token and the same data produce a byte-identical verdict.
- **Tri-state sources** — an outage is never treated as knowledge. One source down
  yields `unknown` checks and a lower coverage score, never a passing one; both down
  raises rather than returning a verdict.
- **Nothing is charged for what we cannot report on** — validation, source, and report
  failures remain non-2xx before settlement. Post-settlement uncertainty is reported
  separately as unknown or confirmed rather than incorrectly called unpaid.
- **Cold-agent discovery** — the payment challenge names `tokenAddress` as required,
  constrains it, lists the supported chains, and advertises an https resource.
- **Recovery** — the settlement transaction returns byte-identical bytes; a request
  hash alone is refused; a deleted record returns null rather than a stale index hit.
- **The report is self-contained** — no scripts, no webfonts, no external assets, and
  hostile values cannot inject markup.
- **The limiter** — bounds unsigned, new, and malformed `/dossier` attempts but
  exempts authenticated internal calls and exact signed retries already backed
  by durable replay state. It cannot be evaded by a spoofed `X-Forwarded-For`,
  and leaves a log line when it blocks someone.
- **The method contract** — GET and POST work; HEAD, PUT, PATCH, DELETE and
  OPTIONS all land >= 400, which is what makes them structurally unchargeable.
- **The pages satisfy their own CSP** — every inline script the server actually
  serves is hashed in the header it serves beside it, and `script-src` allows
  neither `unsafe-inline` nor `unsafe-eval`. A script that drifts from its hash
  breaks the page in every browser while every server-side test still passes.
- **A credential outage** (`payment-outage.test.ts`) — external callers get 503
  and never a free report, while the fulfilment daemon can still serve a task
  buyer whose payment never depended on our facilitator credentials.
- **The ways a client actually calls** — a paid GET with a query string, a paid
  POST with a JSON body, and `X-PAYMENT` as well as `PAYMENT-SIGNATURE`. This
  service has already answered a paid caller 400 once for replaying in a shape
  it did not read, so every supported shape is pinned rather than assumed.
- **"Invalid" is not "unknown"** — a facilitator that answers `isValid: false`
  gets a 402, because that is a refusal. A facilitator that answers nothing at
  all gets a 503 that says which call went unanswered, whether anything was
  taken, and whether it is safe to retry. The SDK returns 402 for both, which
  tells a buyer who has just signed a payment that it was rejected when the
  truth is that we could not check it.
- **The paid path itself** (`settlement.test.ts`) — the real x402 middleware
  against a sandbox facilitator, with no credentials involved. Verify runs
  before the handler and settle after it; the report and replay pointer are durable
  before money moves; a rejected payment, an invalid request, a 404, a paid HEAD and
  an unreachable verify all reach settle zero times; a final receipt is validated and
  atomically claimed; finalized retries return the original bytes before verification;
  and an unknown settlement hands the buyer no document and cannot be settled again.
- **The verifier in a browser** (`pnpm test:browser`) — real chromium, so
  "escaped" can be told apart from "executed". Every field of a hostile
  attestation, pasted or carried in an `?attestation=` link, renders as text and
  runs nothing; the CSP refuses a script the page did not ship with; a real
  report passes all three checks and a tampered one fails the right one.
- **A wedged job is visible from outside** — `/health` publishes how long the
  longest-outstanding job has been waiting, and whether our cached XMTP inbox id
  has stopped matching the conversations. The heartbeat only ever proved the
  watcher was *alive*, which is the question nobody needed answered: a watcher
  ticking every 120s over a job it can no longer read looks exactly like an idle
  one. Job counts stay private; a stalled delivery does not.
- **The watcher's one call outward** (`TestTheOneCallOutward`) — `run()` against
  real processes rather than a stub: success, non-zero exit, missing binary,
  unexecutable file and a hang each land in their own class.

`scripts/benchmark.ts` is separate and does hit live APIs: established tokens
(CAKE, UNI, LINK, AAVE, PEPE) must never `abort`, live-sampled thin tokens must
never `proceed`. Run it by hand, not in CI.

CI (`.github/workflows/ci.yml`) runs typecheck, the Node suite, the watcher
suite, the browser suite, a build, a check that `src/generated` matches its
sources, and a smoke test of the built bundle. The browser step is the only
thing that runs `pnpm test:browser`, since it is deliberately out of `pnpm test`
to keep the everyday loop browser-free.

What no test here can prove, and only a real purchase can: that OKX accepts our
credentials, that our HMAC signing is right, and that USD₮0 actually moves. The
facilitator is stubbed at `fetch` rather than driven with live keys, because a
settlement credential in CI is a worse exposure than the bugs it would catch.

## Deploy

The service runs on its own host behind Caddy (automatic TLS), not on a shared
platform: OKX's review environment could not reach a `*.vercel.app` host, and the
facilitator handshake was unreliable from that runtime.

Before restarting a production instance, verify without printing secret values:

- `PAYMENT_REPLAY_KEY` is present and stable across deploys.
- `ARCHIVE_MAC_KEY` and `ARCHIVE_MAC_REQUIRED` match the audited archive state.
- The archive has been backed up and separately checked for unsigned, malformed,
  incompatible legacy-MAC, missing-owner, or ambiguous-transaction records.
- `node --import tsx scripts/archive-migrate.ts apply-verify` reports `strictReady: true` before
  enabling strict archive mode.

### Offline archive migration

The migration tool never invents ownership. A report attestation can verify report
bytes, but it does not prove an archive id, transaction, or job association, so unsigned
records still need an exact hash-bound operator approval. Historical non-chain
`paymentTransaction` placeholders remain MAC-covered metadata and never become current
transaction claims. Request-keyed v1 records have no per-delivery identity at all; the
tool preserves them in a separately checksummed cold archive outside `ARCHIVE_DIR`
instead of fabricating ids or silently deleting history. Moving those legacy records
requires `approve-review`; the lower-level `approve` command can authorize ordinary
record authentication but cannot authorize a cold-archive disposition.

The tool never infers that a record is synthetic. A known synthetic/test artifact may
use the same cold archive without being promoted to trusted history only when an
operator selects it explicitly during the first audit with a relative path, exact
lowercase SHA-256, and specific forensic reason:

```bash
node --import tsx scripts/archive-migrate.ts audit \
  --archive "$ARCHIVE_DIR" \
  --cold-archive-dir "$EVIDENCE_DIR/cold-archive" \
  --quarantine 'record-id.json:exact-sha256:known production smoke-test artifact' \
  --out "$EVIDENCE_DIR/plan.initial.json" \
  --approval-review-out "$EVIDENCE_DIR/approval-review.json"
```

Quarantine accepts structurally recognizable current-format archive JSON even when it
is unsigned, has an invalid MAC, or fails stricter current-record validation. It
preserves the selected bytes verbatim, records the validation result and a fingerprint
of any observed MAC in the authenticated cold manifest, and never treats quarantine as
authentication, payment evidence, or ownership evidence. The selector, reason, archive
snapshot, key fingerprints, and exclusive `quarantine-current-record` review action are
plan-bound through `approve-review`; ordinary `approve` cannot authorize quarantine.
Apply writes and fsyncs the prepared manifest and cold copy, verifies the exact checksum,
and only then removes the matching active source. It fails closed on collisions and can
resume an authenticated prepared manifest after a crash. Repeat the same selectors on a
manual re-audit, or omit them when `--approval` is supplied because the authenticated
approval carries the exact reviewed selector set forward. Do not use the package-script
form with an extra literal `--` on hosts where pnpm forwards it to the CLI; invoking the
script directly as above is unambiguous.

Prepare the checkout, dependencies, and bundle before the outage, but do not restart yet.
Use the repository's pnpm lockfile and a fixed pnpm 10 release compatible with CI
(Corepack can provide pnpm on a host that does not have it on `PATH`). During the
outage, use a runtime mask so a timer, socket, path
unit, or concurrent operator cannot restart Dossier; discover the actual units named by
`TriggeredBy`, record their prior state, and stop/mask only those units. Confirm the
service is inactive and dead, both PIDs are zero, its cgroup has no processes, and no
Dossier process remains.
A live service owns `.archive-service.lock`; migration owns `.archive-migration.lock`, so
either side fails closed if the other attempts to start during maintenance. A leftover lease
after a crash is an operator-visible blocker: remove only that exact stale lease directory,
and only after the process and cgroup checks prove that no service instance remains.

```bash
# Before the maintenance window: stage and verify the code that will be started
# later. Do not restart the service in this phase.
set -euo pipefail
umask 077
cd /home/ubuntu/dossier
git pull --ff-only
corepack prepare pnpm@10.30.1 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm build:server
grep -Fq 'payment_reconciliation_pending' dist/server.mjs

# Secrets come from a protected environment file, never command arguments.
# ARCHIVE_LEGACY_MAC_KEY is needed only when validating an older MAC format.
set -a
source /path/to/dossier.env
set +a
export ARCHIVE_DIR=/home/ubuntu/.dossier-archive
EVIDENCE_DIR="/var/backups/dossier-migration-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$EVIDENCE_DIR"
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" \
  "$EVIDENCE_DIR/cold-archive"

# Record the actual trigger units first. Do not guess names or create units merely
# because they appear in an example. This writes a shell-safe, newline-delimited
# list for the same maintenance window; review it before masking.
TRIGGER_FILE="$EVIDENCE_DIR/triggered-by.txt"
MASKED_TRIGGER_FILE="$EVIDENCE_DIR/triggered-masked.txt"
CGROUP="$(systemctl show dossier.service --value -p ControlGroup)"
test -n "$CGROUP"
systemctl show dossier.service --value -p TriggeredBy | tr ' ' '\n' | sed '/^$/d' | sort -u > "$TRIGGER_FILE"
: > "$MASKED_TRIGGER_FILE"
while IFS= read -r unit; do
  systemctl show "$unit" -p LoadState --value | grep -qx loaded || continue
  mask_unit=0
  if systemctl is-enabled "$unit" >/dev/null 2>&1; then
    printf '%s\n' "$unit" >> "$EVIDENCE_DIR/triggered-enabled.txt"
    mask_unit=1
  fi
  if systemctl is-active "$unit" >/dev/null 2>&1; then
    printf '%s\n' "$unit" >> "$EVIDENCE_DIR/triggered-active.txt"
    mask_unit=1
  fi
  test "$mask_unit" -eq 1 || continue
  printf '%s\n' "$unit" >> "$MASKED_TRIGGER_FILE"
  sudo systemctl mask --runtime --now "$unit"
done < "$TRIGGER_FILE"
sudo systemctl mask --runtime --now dossier.service
systemctl show dossier.service \
  -p ActiveState -p SubState -p MainPID -p ControlPID -p UnitFileState \
  -p TriggeredBy -p ControlGroup
systemctl status dossier.service --no-pager || true
test "$(systemctl show dossier.service --value -p MainPID)" = 0
test "$(systemctl show dossier.service --value -p ControlPID)" = 0
if test -e "/sys/fs/cgroup$CGROUP/cgroup.procs"; then
  ! grep -q . "/sys/fs/cgroup$CGROUP/cgroup.procs"
fi
! pgrep -af '^(/usr/bin/)?node .*([/]home[/]ubuntu[/]dossier|dist[/]server[.]mjs|src[/]server[.]ts)' || {
  echo 'a Dossier Node process is still running' >&2
  exit 1
}
# The watcher may belong to dossier-fulfill.service or to an operator session.
# Stop it through its actual owner; do not guess a unit name or kill a broad match.
! pgrep -af '^(/usr/bin/)?python3? /home/ubuntu/dossier/ops/fulfill-watcher[.]py' || {
  echo 'the Dossier fulfillment watcher is still running' >&2
  exit 1
}

# First pass: create a reviewable inventory of every byte set needing trust.
# If and only if an exact current-format record is already known to be a test
# artifact, add one reviewed --quarantine path:sha256:reason selector here.
node --import tsx scripts/archive-migrate.ts audit \
  --archive "$ARCHIVE_DIR" \
  --cold-archive-dir "$EVIDENCE_DIR/cold-archive" \
  --out "$EVIDENCE_DIR/plan.initial.json" \
  --approval-review-out "$EVIDENCE_DIR/approval-review.json"

# Review the paths, SHA-256 values, findings, and intended actions. Then bind one
# explicit reason to that exact reviewed inventory.
node --import tsx scripts/archive-migrate.ts approve-review \
  --archive "$ARCHIVE_DIR" \
  --review "$EVIDENCE_DIR/approval-review.json" \
  --reason "matched reviewed production snapshot and deployment history" \
  --out "$EVIDENCE_DIR/approval.json"

# Re-audit with approval. Resolve every ERROR before continuing; do not choose an
# owner automatically for a real duplicated chain transaction.
node --import tsx scripts/archive-migrate.ts audit \
  --archive "$ARCHIVE_DIR" \
  --cold-archive-dir "$EVIDENCE_DIR/cold-archive" \
  --approval "$EVIDENCE_DIR/approval.json" \
  --out "$EVIDENCE_DIR/plan.json"

node --import tsx scripts/archive-migrate.ts backup \
  --plan "$EVIDENCE_DIR/plan.json" \
  --backup-dir "$EVIDENCE_DIR/active-pre-migration" \
  --out "$EVIDENCE_DIR/backup-manifest.json"

# Type the exact planDigest printed by audit. The combined operation is
# idempotent and holds the migration interlock continuously through strict
# verification, so the service cannot start between mutation and verification.
node --import tsx scripts/archive-migrate.ts apply-verify \
  --plan "$EVIDENCE_DIR/plan.json" \
  --backup-manifest "$EVIDENCE_DIR/backup-manifest.json" \
  --confirm <exact-plan-digest>

# Now set ARCHIVE_MAC_REQUIRED=1 in the protected EnvironmentFile used by the
# service, then reload unit state while the service remains runtime-masked.
sudo systemctl daemon-reload
sudo systemctl unmask --runtime dossier.service
sudo systemctl start dossier.service

# Remove runtime masks from every trigger that was actually present. Persistent
# enablement was never changed; restart only those that were active beforehand.
while IFS= read -r unit; do
  sudo systemctl unmask --runtime "$unit"
done < "$MASKED_TRIGGER_FILE"
if test -s "$EVIDENCE_DIR/triggered-active.txt"; then
  while IFS= read -r unit; do sudo systemctl start "$unit"; done < "$EVIDENCE_DIR/triggered-active.txt"
fi
```

Do not unmask or start the service until strict verification succeeds and the protected
service environment has `ARCHIVE_MAC_REQUIRED=1`. Keep the authenticated backup manifest,
cold-archive manifest, plan, approval, and review inventory together in the timestamped,
mode-0700 evidence directory. If a listed trigger unit did not exist or was not enabled
before maintenance, do not create or enable it merely because it appears in the example.

After restart, `/health` must report `paidReady: true`, `archiveReady: true`,
`paymentReplayReady: true`, and `paymentLayer: "ready"`. Inspect `archiveMode`,
`archiveUnsignedRecords`, and `archiveReadinessReason` explicitly; `ok: true` means
the process and free surface are alive, not that paid delivery is available. The
durability fields are cached for 30 seconds so public health polling cannot force an
archive-wide scan and fsync on every request.

Verify a dependency deploy actually landed, rather than assuming it did:

```bash
node -pe "require('./node_modules/<pkg>/package.json').version"
```

The landing page's fonts and its GSAP/Lenis bundle are emitted as ordinary
TypeScript into `src/generated/` by `scripts/build-assets.mjs` and
`scripts/build-client.mjs`, and both are committed. That is deliberate: an
esbuild-only loader for `.woff2` would work in the bundle and break `pnpm dev`,
`pnpm start` and the test runner, which is exactly what happened once. Generated
TypeScript works everywhere with no loader configuration, and it keeps the
command above working on a host that has not installed the client-side
devDependencies.

If you change anything under `src/client/` or `src/assets/`, run
`pnpm build:server`, which regenerates both first and so cannot ship a stale
bundle. CI fails if `src/generated` does not match its sources.

Verify the new code is actually in the bundle before restarting — a silent build
failure otherwise leaves the previous version serving:

```bash
grep -Fq 'payment_reconciliation_pending' dist/server.mjs
```

A `src/vercel.ts` entry and `pnpm build:api` are kept for free/demo serverless previews,
with `vercel.json` pinning `framework: null` (a framework preset once built a second
broken lambda that captured `/`). The entry hard-fails if paid configuration is present,
and the intentionally named `deploy:vercel-demo` script never deploys with `--prod`.
Production is the standalone VPS service only.

## Delivery model

Dossier is an **A2MCP / x402** service, so delivery is **pull-based**: after the buyer
pays, their client replays the request to the endpoint and receives the report in the
response body. This is OKX's designed flow for x402 — there is no seller-side push or
escrow `deliver` step (the CLI explicitly rejects `deliver` for paymentMode 3, and
backend attachment registration is not available for x402 tasks). The practical
consequence is that the **endpoint host must be reachable from the buyer's environment**,
which is why the service runs on a dedicated domain rather than a shared `*.vercel.app`
host that some corporate networks filter.

`format: "message"` returns the buyer-facing delivery text itself, finished, from the same
run that produced the report. It is an internal fulfilment-only view and requires the
authenticated daemon request plus a valid `x-job-id`; external paid callers are rejected
before settlement and must request `html` or `json`. Both fulfilment paths fetch it and
paste it; neither writes it. They used to write their own, from the same JSON, and the two disagreed: on
2026-08-03 one of them told a buyer "safe position size ≈ $78,345" for a token the next
line of the same message flagged as mintable with an unrenounced owner. The number is 1%
of the deepest pool's base-side liquidity, halved on caution, and the report calls it a
heuristic size cap. A service whose claim is that no LLM touches the analysis cannot have
one paraphrasing the verdict into the buyer's inbox.

The text carries a single substitution marker, `ATTACHMENT_BLOCK`, replaced with the
encrypted-attachment parameters that only exist after the upload. Nothing else is edited.

The message is a view of a report that was already delivered, not a delivery of its own,
so it is not archived. Giving it its own record made it the newest one for the job, and a
buyer who recovered got back the message they were already holding instead of their
document. The recovery code is attached to the report itself.

The marketplace agrees. `onchainos agent complete` refuses an x402 task whose replay
never succeeded, with `x402_no_deliverable`, **even when a deliverable is registered and
the report has been delivered into the job channel** (verified 2026-08-04 on two live
jobs). Completion is gated on the buyer's own 2xx, not on anything we push. So the A2A
channel can rescue a buyer's *report*, but it cannot close their *task*: a buyer whose
replay failed has to replay successfully before the job can complete, and no amount of
seller-side delivery substitutes for that.

An `okx-a2a` daemon (on an always-on VPS, not in this repo) additionally watches accepted
jobs and can send the report summary plus retrieval details to the buyer as an A2A/XMTP
message — a best-effort courtesy channel, not a substitute for the endpoint pull.
