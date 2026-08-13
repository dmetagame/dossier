import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

test("the standalone entry refuses unsafe configuration before listening", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DEV_SKIP_PAYMENT: "1",
        PORT: "0",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe standalone configuration/);
  assert.match(result.stderr, /DEV_SKIP_PAYMENT/);
  assert.doesNotMatch(result.stdout, /listening on/);
});
