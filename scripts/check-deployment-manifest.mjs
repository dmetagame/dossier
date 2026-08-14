import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
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
const requireClean = process.argv.slice(2).includes("--require-clean");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--require-clean");
if (unknown.length) throw new Error(`unknown argument: ${unknown.join(" ")}`);

function gitOutput(args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    env: gitEnv,
  }).trim();
}

function sourceDiffers() {
  const args = ["status", "--porcelain=v1", "--untracked-files=normal", "--", ...sourceInputs];
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    env: gitEnv,
  });
  if (result.status === 0) return result.stdout.length > 0;
  throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
}

function ensureIgnored(path) {
  const result = spawnSync("/usr/bin/git", ["check-ignore", "-q", "--", path], {
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

const manifest = JSON.parse(
  readFileSync(join(root, "dist", "deployment-manifest.json"), "utf8"),
);
if (manifest?.schemaVersion !== 1) throw new Error("unsupported deployment manifest schema");
if (!/^[0-9a-f]{40}$/.test(manifest.sourceSha ?? "")) {
  throw new Error("deployment manifest has no valid source SHA");
}
if (typeof manifest.sourceDirty !== "boolean") {
  throw new Error("deployment manifest has no sourceDirty state");
}

const sourceSha = gitOutput(["rev-parse", "HEAD"]);
const sourceDirty = sourceDiffers();
if (manifest.sourceSha !== sourceSha) {
  throw new Error(`bundle source ${manifest.sourceSha} does not match checkout ${sourceSha}`);
}
if (manifest.sourceDirty !== sourceDirty) {
  throw new Error("bundle inputs changed after the deployment manifest was written");
}
if (requireClean && sourceDirty) {
  throw new Error("production refuses a bundle whose source or operational inputs differ from HEAD");
}

const expectedArtifacts = ["dist/server.mjs", "dist/config-check.mjs"];
for (const path of expectedArtifacts) {
  const expected = manifest.artifacts?.[path];
  if (!/^[0-9a-f]{64}$/.test(expected ?? "")) {
    throw new Error(`deployment manifest has no valid SHA-256 for ${path}`);
  }
  const actual = sha256(path);
  if (actual !== expected) throw new Error(`${path} does not match its deployment manifest`);
}

console.log(
  `deployment manifest matches ${sourceSha.slice(0, 12)}` +
    (sourceDirty ? " (bundle inputs differ from HEAD)" : ""),
);
