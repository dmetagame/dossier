# Dossier systemd rollout

These units are the production definitions for the standalone VPS service and
the ASP fulfilment timer. They intentionally keep the existing `ubuntu` service
account for the first hardening rollout. A later migration to dedicated service
accounts can remove the residual exposure from that account's host groups.

## Prepare the exact revision

Production starts only a clean checkout whose generated bundles are tied to its
Git revision and SHA-256 values by `dist/deployment-manifest.json`.

```bash
set -euo pipefail
cd /home/ubuntu/dossier
git pull --ff-only
corepack prepare pnpm@10.30.1 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm build:server
corepack pnpm check:server-build
corepack pnpm check:deployment
corepack pnpm check:systemd
systemd-analyze verify \
  "$PWD/ops/systemd/dossier.service" \
  "$PWD/ops/systemd/dossier-fulfill.service" \
  "$PWD/ops/systemd/dossier-fulfill.timer"
```

Do not restart if any command fails. The manifest gate also runs as
`ExecStartPre` for both services, so a later source or artifact change fails
closed instead of silently starting a stale bundle.

## Install with a rollback copy

The legacy host has a `dossier.service.d/10-config-check.conf` drop-in. The new
full service already contains that preflight, so preserve and retire the drop-in
or the check will run twice.

```bash
set -euo pipefail
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/var/backups/dossier-systemd-$stamp"
sudo install -d -m 0700 -o root -g root "$backup_dir"
for path in \
  /etc/systemd/system/dossier.service \
  /etc/systemd/system/dossier-fulfill.service \
  /etc/systemd/system/dossier-fulfill.timer \
  /etc/systemd/system/dossier.service.d/10-config-check.conf; do
  if sudo test -e "$path"; then
    sudo cp -a "$path" "$backup_dir/"
  fi
done

sudo systemctl stop dossier-fulfill.timer
while systemctl is-active --quiet dossier-fulfill.service; do sleep 1; done

# Existing files predate UMask=0077. Tighten them before the new preflight.
for path in \
  /home/ubuntu/.okx-agent-task/fulfill-watcher-state.json \
  /home/ubuntu/.okx-agent-task/fulfill-watcher-state.json.lock \
  /home/ubuntu/.okx-agent-task/fulfill-watcher-heartbeat.json; do
  if test -e "$path"; then chmod 0600 "$path"; fi
done

sudo install -m 0644 ops/systemd/dossier.service \
  /etc/systemd/system/dossier.service
sudo install -m 0644 ops/systemd/dossier-fulfill.service \
  /etc/systemd/system/dossier-fulfill.service
sudo install -m 0644 ops/systemd/dossier-fulfill.timer \
  /etc/systemd/system/dossier-fulfill.timer
if sudo test -e /etc/systemd/system/dossier.service.d/10-config-check.conf; then
  sudo mv /etc/systemd/system/dossier.service.d/10-config-check.conf \
    "$backup_dir/10-config-check.conf.retired"
fi

sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/dossier.service \
  /etc/systemd/system/dossier-fulfill.service \
  /etc/systemd/system/dossier-fulfill.timer
sudo systemctl start dossier-fulfill.service
sudo systemctl enable --now dossier-fulfill.timer
sudo systemctl restart dossier.service
```

## Verify the full story

```bash
set -euo pipefail
systemctl is-active --quiet dossier.service
systemctl is-active --quiet dossier-fulfill.timer
systemctl is-enabled --quiet dossier.service
systemctl is-enabled --quiet dossier-fulfill.timer
test "$(stat -c '%a' /run/dossier-fulfill/heartbeat.json)" = 600
ss -ltnp | grep -F '127.0.0.1:3000'
curl -fsS https://dossier.rouma.xyz/health/live
curl -fsS https://dossier.rouma.xyz/health/ready
curl -fsS https://dossier.rouma.xyz/health
systemd-analyze security dossier.service
systemd-analyze security dossier-fulfill.service
```

The ready response must be HTTP 200 with `paidReady`, `archiveReady`, and
`paymentReplayReady` true, strict archive mode, zero unsigned records, and the
payment layer ready. An unsigned dossier request must still return 402; this
rollout does not authorize a paid transaction.

## Roll back the unit definitions

If either hardened service fails, restore the exact files from `backup_dir`,
reload systemd, and restart the prior definitions. Restore the retired drop-in
as `/etc/systemd/system/dossier.service.d/10-config-check.conf`. The application
checkout and `.env` backup are separate and must not be deleted by unit rollback.
