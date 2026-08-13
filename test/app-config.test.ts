import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

test("an alternate app import cannot enable the payment bypass in production", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", "await import('./src/app.ts')"],
    {
      cwd: repoDir,
      env: { ...process.env, NODE_ENV: "production", DEV_SKIP_PAYMENT: "1" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEV_SKIP_PAYMENT/);
});
