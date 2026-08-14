import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = "/usr/bin/git";
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const sourceInputs = [
  ".github/workflows/ci.yml",
  ".gitignore",
  "ops/fulfill-watcher.py",
  "ops/systemd",
  "ops/test_fulfill_watcher.py",
  "package.json",
  "pnpm-lock.yaml",
  "scripts",
  "src",
  "test",
  "tsconfig.json",
];

function gitOutput(args) {
  return execFileSync(git, args, { cwd: root, encoding: "utf8", env: gitEnv }).trim();
}

function sourceDiffers() {
  const args = ["status", "--porcelain=v1", "--untracked-files=normal", "--", ...sourceInputs];
  const result = spawnSync(git, args, { cwd: root, encoding: "utf8", env: gitEnv });
  if (result.status === 0) return result.stdout.length > 0;
  throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
}

function ensureIgnored(path) {
  const result = spawnSync(git, ["check-ignore", "-q", "--", path], {
    cwd: root,
    env: gitEnv,
  });
  if (result.status === 0) return;
  if (result.status === 1) {
    throw new Error(`${path} must remain ignored; generated deployment artifacts are not source`);
  }
  throw new Error(`git check-ignore failed for ${path}`);
}

for (const path of ["dist/server.mjs", "dist/config-check.mjs", "dist/deployment-manifest.json"]) {
  ensureIgnored(path);
}

const manifest = {
  schemaVersion: 1,
  sourceSha: gitOutput(["rev-parse", "HEAD"]),
  sourceDirty: sourceDiffers(),
  artifacts: {
    "dist/server.mjs": sha256("dist/server.mjs"),
    "dist/config-check.mjs": sha256("dist/config-check.mjs"),
  },
};

const destination = join(root, "dist", "deployment-manifest.json");
const temporary = `${destination}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
renameSync(temporary, destination);
console.log(
  `wrote deployment manifest for ${manifest.sourceSha.slice(0, 12)}` +
    (manifest.sourceDirty ? " (bundle inputs differ from HEAD)" : ""),
);
