import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (name) => readFileSync(join(root, "ops/systemd", name), "utf8");
const service = read("dossier.service");
const watcher = read("dossier-fulfill.service");
const timer = read("dossier-fulfill.timer");

function requireLines(name, text, lines) {
  const present = new Set(text.split(/\r?\n/));
  for (const line of lines) {
    if (!present.has(line)) throw new Error(`${name} is missing: ${line}`);
  }
}

const common = [
  "UMask=0077",
  "NoNewPrivileges=yes",
  "CapabilityBoundingSet=",
  "AmbientCapabilities=",
  "PrivateTmp=yes",
  "PrivateDevices=yes",
  "ProtectSystem=strict",
  "ProtectHome=read-only",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectKernelLogs=yes",
  "ProtectControlGroups=yes",
  "ProtectClock=yes",
  "ProtectHostname=yes",
  "ProtectProc=invisible",
  "RestrictSUIDSGID=yes",
  "RestrictRealtime=yes",
  "RestrictNamespaces=yes",
  "LockPersonality=yes",
  "SystemCallArchitectures=native",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
];

requireLines("dossier.service", service, [
  ...common,
  "ExecStartPre=/usr/bin/node /home/ubuntu/dossier/scripts/check-deployment-manifest.mjs --require-clean",
  "ExecStartPre=/usr/bin/node /home/ubuntu/dossier/dist/config-check.mjs",
  "ExecStart=/usr/bin/node /home/ubuntu/dossier/dist/server.mjs",
  "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin",
  "Environment=DOSSIER_FULFILL_HEARTBEAT_FILE=/run/dossier-fulfill/heartbeat.json",
  "ReadOnlyPaths=/home/ubuntu/dossier",
  "ReadWritePaths=/home/ubuntu/.dossier-archive",
  "NoExecPaths=/home/ubuntu/.dossier-archive",
  "InaccessiblePaths=-/home/ubuntu/.ssh -/home/ubuntu/.claude -/home/ubuntu/.claude.json -/home/ubuntu/.npmrc -/home/ubuntu/.okx-agent-task -/home/ubuntu/.onchainos -/run/lxd-installer.socket -/var/snap/lxd/common/lxd/unix.socket -/var/lib/lxd/unix.socket -/run/docker.sock -/var/run/docker.sock -/run/snapd.socket -/run/snapd-snap.socket",
]);
requireLines("dossier-fulfill.service", watcher, [
  ...common,
  "ExecStartPre=/usr/bin/node /home/ubuntu/dossier/scripts/check-deployment-manifest.mjs --require-clean",
  "ExecStartPre=/usr/bin/python3 /home/ubuntu/dossier/ops/fulfill-watcher.py --preflight",
  "ExecStart=/usr/bin/python3 /home/ubuntu/dossier/ops/fulfill-watcher.py --run",
  "Environment=DOSSIER_FULFILL_HEARTBEAT_FILE=/run/dossier-fulfill/heartbeat.json",
  "Environment=NODE_OPTIONS=--dns-result-order=ipv4first",
  "TimeoutStartSec=30min",
  "RuntimeDirectory=dossier-fulfill",
  "RuntimeDirectoryMode=0700",
  "RuntimeDirectoryPreserve=yes",
  "ReadOnlyPaths=/home/ubuntu/dossier /home/ubuntu/.local /home/ubuntu/.npm-global",
  "ReadWritePaths=/home/ubuntu/.okx-agent-task /home/ubuntu/.onchainos",
  "NoExecPaths=/home/ubuntu/.okx-agent-task",
  "InaccessiblePaths=-/home/ubuntu/.ssh -/home/ubuntu/.claude -/home/ubuntu/.claude.json -/home/ubuntu/.npmrc -/home/ubuntu/.dossier-archive -/run/lxd-installer.socket -/var/snap/lxd/common/lxd/unix.socket -/var/lib/lxd/unix.socket -/run/docker.sock -/var/run/docker.sock -/run/snapd.socket -/run/snapd-snap.socket",
]);
requireLines("dossier-fulfill.timer", timer, [
  "OnBootSec=90s",
  "OnUnitInactiveSec=120s",
  "AccuracySec=15s",
  "Unit=dossier-fulfill.service",
]);

for (const [name, text] of [["dossier.service", service], ["dossier-fulfill.service", watcher]]) {
  if (/^ReadWritePaths=\/$/m.test(text)) throw new Error(`${name} grants write access to /`);
  if (/^ProtectHome=(?:no|false)$/m.test(text)) throw new Error(`${name} leaves home directories unprotected`);
  if (/^SystemCallFilter=/m.test(text)) throw new Error(`${name} enables an unproven syscall filter`);
}

if (/^\[Install\]/m.test(watcher)) throw new Error("the timer, not the oneshot watcher, must be enabled");
if (/^Persistent=/m.test(timer)) throw new Error("monotonic watcher timers must not claim calendar persistence");

console.log("checked-in systemd units keep writes scoped and sandboxing enabled");
