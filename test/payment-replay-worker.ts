import { writeFileSync } from "node:fs";

import * as replay from "../src/payment-replay";

const [fingerprint, readyPath] = process.argv.slice(2);
if (!fingerprint || !readyPath) {
  throw new Error("payment replay worker requires a fingerprint and ready path");
}

const request: replay.ReplayRequestIdentity = {
  paramsSha256: "a".repeat(64),
  contentType: "text/html",
};
const requirements: replay.ReplayRequirements = {
  scheme: "exact",
  network: "eip155:196",
  amount: "10000",
  asset: "0x0000000000000000000000000000000000000001",
  payTo: "0x0000000000000000000000000000000000000002",
};

const result = replay.begin(fingerprint, request, requirements);
writeFileSync(readyPath, JSON.stringify(result), { flag: "wx", mode: 0o600 });

// Keep the owner alive until the parent deliberately terminates this worker.
setInterval(() => undefined, 1_000);
