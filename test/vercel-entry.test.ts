import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

test("the Vercel entry refuses paid configuration before serving", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", "await import('./src/vercel.ts')"],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        DEV_SKIP_PAYMENT: "0",
        PAY_TO: "0x0000000000000000000000000000000000000001",
        OKX_API_KEY: "configured-test-key",
        OKX_SECRET_KEY: "configured-test-secret",
        OKX_PASSPHRASE: "configured-test-passphrase",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /paid Dossier cannot run in the Vercel function entry/);
});
