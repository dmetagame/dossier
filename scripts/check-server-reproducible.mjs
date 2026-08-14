import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const esbuild = join(process.cwd(), "node_modules", ".bin", "esbuild");
const scratch = mkdtempSync(join(tmpdir(), "dossier-server-build-"));
const entries = [
  { source: "src/server.ts", output: "server.mjs" },
  { source: "src/config-check.ts", output: "config-check.mjs" },
];

function compile(source, outfile) {
  execFileSync(
    esbuild,
    [
      source,
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=esm",
      `--outfile=${outfile}`,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
}

try {
  for (const { source, output } of entries) {
    const first = join(scratch, `first-${output}`);
    const second = join(scratch, `second-${output}`);
    compile(source, first);
    compile(source, second);

    const firstBytes = readFileSync(first);
    const secondBytes = readFileSync(second);
    if (!firstBytes.equals(secondBytes)) {
      throw new Error(`${source} produced different bytes in consecutive CLI builds`);
    }

    const committedBuild = readFileSync(join("dist", output));
    if (!firstBytes.equals(committedBuild)) {
      throw new Error(`dist/${output} is stale; run pnpm build:server before deployment`);
    }
  }
  execFileSync(process.execPath, ["scripts/check-deployment-manifest.mjs"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("server and config-check bundles are deterministic and match current source");
