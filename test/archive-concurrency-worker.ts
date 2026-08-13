import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as archive from "../src/dossier/archive";
import * as replay from "../src/payment-replay";

const WAIT_TIMEOUT_MS = 20_000;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

function waitFor(path: string): void {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(waitArray, 0, 0, 10);
  }
}

function publish(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
}

const [action, readyPath, gatePath, resultPath, ...args] = process.argv.slice(2);

if (!action || !readyPath || !gatePath || !resultPath) {
  throw new Error("worker requires action, ready, gate, and result paths");
}

try {
  let value: unknown;

  if (action === "lookup-after-miss") {
    const [transaction] = args;
    if (!transaction) throw new Error("lookup-after-miss requires a transaction");
    const first = archive.byTransaction(transaction);
    publish(readyPath, { pid: process.pid });
    waitFor(gatePath);
    const second = archive.byTransaction(transaction);
    value = { firstId: first?.id ?? null, secondId: second?.id ?? null };
  } else {
    publish(readyPath, { pid: process.pid });
    waitFor(gatePath);

    if (action === "acquire-lease") {
      const [statusPath, releasePath] = args;
      if (!statusPath || !releasePath) {
        throw new Error("acquire-lease requires status and release paths");
      }
      const acquired = archive.acquireServiceLeaseForServer();
      publish(statusPath, { acquired, pid: process.pid });
      waitFor(releasePath);
      if (acquired) archive.releaseServiceLeaseAfterDrain();
      value = { acquired, pid: process.pid };
    } else if (action === "acquire-lease-gap") {
      const [statusPath, restoreSignal, restoredPath, releasePath] = args;
      if (!statusPath || !restoreSignal || !restoredPath || !releasePath) {
        throw new Error("acquire-lease-gap requires status, restore signal, restored, and release paths");
      }
      const acquired = archive.acquireServiceLeaseForServer();
      let ownerPath: string | null = null;
      let ownerBody: string | null = null;
      if (acquired) {
        const lease = join(process.env.ARCHIVE_DIR!, ".archive-service.lock");
        const ownerName = readdirSync(lease)[0];
        if (!ownerName) throw new Error("service lease owner was not published");
        ownerPath = join(lease, ownerName);
        ownerBody = readFileSync(ownerPath, "utf8");
        unlinkSync(ownerPath);
      }
      publish(statusPath, { acquired, pid: process.pid });
      waitFor(restoreSignal);
      if (acquired && ownerPath && ownerBody) {
        writeFileSync(ownerPath, ownerBody, { flag: "wx", mode: 0o600 });
      }
      publish(restoredPath, { restored: acquired, pid: process.pid });
      waitFor(releasePath);
      if (acquired) archive.releaseServiceLeaseAfterDrain();
      value = { acquired, pid: process.pid };
    } else if (action === "link") {
      const [id, transaction] = args;
      if (!id || !transaction) throw new Error("link requires a record id and transaction");
      const result = archive.linkConfirmedSettlement(id, {
        status: "confirmed",
        transaction,
        network: "eip155:196",
        amount: "10000",
        payer: `0x${"12".repeat(20)}`,
      });
      value = {
        kind: result.kind,
        ownerId: "owner" in result ? result.owner.id : null,
      };
    } else if (action === "discard") {
      const [id] = args;
      if (!id) throw new Error("discard requires a record id");
      value = { discarded: archive.discard(id) };
    } else if (action === "prune") {
      let saved = 0;
      for (let i = 0; i < 25; i++) {
        const id = archive.newId();
        if (
          archive.save({
            id,
            paramsSha256: "e".repeat(64),
            request: { filler: i },
            contentType: "text/plain",
            deliverable: `filler-${i}`,
            deliveredAt: new Date().toISOString(),
          })
        ) {
          saved++;
        }
      }
      value = { saved };
    } else if (action === "attach-replay") {
      const [fingerprint, attemptToken, reportId] = args;
      if (!fingerprint || !attemptToken || !reportId) {
        throw new Error("attach-replay requires fingerprint, attempt token, and report id");
      }
      value = { attached: replay.attachReport(fingerprint, attemptToken, reportId) };
    } else if (action === "release-replay") {
      const [fingerprint, attemptToken] = args;
      if (!fingerprint || !attemptToken) {
        throw new Error("release-replay requires fingerprint and attempt token");
      }
      value = { released: replay.release(fingerprint, attemptToken) };
    } else {
      throw new Error(`unknown worker action: ${action}`);
    }
  }

  publish(resultPath, { ok: true, value });
} catch (error) {
  publish(resultPath, {
    ok: false,
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
  process.exitCode = 1;
}
