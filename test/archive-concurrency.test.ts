import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { tempArchive } from "./helpers";
import * as archive from "../src/dossier/archive";
import * as replay from "../src/payment-replay";
import { archiveRecordMac } from "../src/dossier/archive-format";

const CHILD_TIMEOUT_MS = 20_000;
const MAC_KEY = "archive-concurrency-test-key";
const workerPath = fileURLToPath(new URL("./archive-concurrency-worker.ts", import.meta.url));
const repoDir = fileURLToPath(new URL("..", import.meta.url));
const archiveTemp = tempArchive();
const controlTemp = tempArchive();
const dir = archiveTemp.dir;
const controlDir = controlTemp.dir;
const activeChildren = new Set<ChildProcess>();

const previousArchiveDir = process.env.ARCHIVE_DIR;
const previousMacKey = process.env.ARCHIVE_MAC_KEY;
const previousMacRequired = process.env.ARCHIVE_MAC_REQUIRED;
const previousReplayKey = process.env.PAYMENT_REPLAY_KEY;
process.env.ARCHIVE_DIR = dir;
process.env.ARCHIVE_MAC_KEY = MAC_KEY;
process.env.ARCHIVE_MAC_REQUIRED = "1";
process.env.PAYMENT_REPLAY_KEY = "archive-concurrency-replay-key";

interface WorkerHandle {
  child: ChildProcess;
  readyPath: string;
  gatePath: string;
  resultPath: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
}

interface LinkResult {
  kind: string;
  ownerId: string | null;
}

function replayFingerprint(requirements: replay.ReplayRequirements): string {
  const semanticRequirements = {
    ...requirements,
    maxTimeoutSeconds: 300,
    extra: { name: "Concurrency Test Token", version: "1" },
  };
  const nonce = createHash("sha256").update(randomUUID()).digest("hex");
  return replay.fingerprintPayment(
    {
      x402Version: 2,
      accepted: semanticRequirements,
      payload: {
        signature: "0x" + "11".repeat(65),
        authorization: {
          from: `0x${"09".repeat(20)}`,
          to: requirements.payTo,
          value: requirements.amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${nonce}`,
        },
      },
    },
    semanticRequirements,
  )!;
}

function clean(path: string): void {
  for (const name of readdirSync(path)) {
    rmSync(join(path, name), { recursive: true, force: true });
  }
}

function controlPath(label: string): string {
  return join(controlDir, `${label}-${randomUUID()}`);
}

function releaseGate(path: string): void {
  writeFileSync(path, "go", { flag: "wx", mode: 0o600 });
}

function releaseGateIfNeeded(path: string): void {
  if (!existsSync(path)) releaseGate(path);
}

async function waitForFile(path: string, description: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(10);
  }
}

function launchWorker(action: string, args: string[], gatePath = controlPath("gate")): WorkerHandle {
  const readyPath = controlPath("ready");
  const resultPath = controlPath("result");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, action, readyPath, gatePath, resultPath, ...args],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        ARCHIVE_DIR: dir,
        ARCHIVE_MAC_KEY: MAC_KEY,
        ARCHIVE_MAC_REQUIRED: "1",
        PAYMENT_REPLAY_KEY: "archive-concurrency-replay-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeChildren.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      resolve({ code, signal });
    });
  });

  return { child, readyPath, gatePath, resultPath, exit, stdout: () => stdout, stderr: () => stderr };
}

async function collectWorker<T>(handle: WorkerHandle): Promise<T> {
  const outcome = await Promise.race([
    handle.exit,
    delay(CHILD_TIMEOUT_MS, null, { ref: false }),
  ]);
  if (!outcome) {
    handle.child.kill("SIGKILL");
    throw new Error(`worker timed out\nstdout: ${handle.stdout()}\nstderr: ${handle.stderr()}`);
  }
  assert.equal(
    outcome.code,
    0,
    `worker exited with ${outcome.code ?? outcome.signal}\nstdout: ${handle.stdout()}\nstderr: ${handle.stderr()}`,
  );
  assert.ok(existsSync(handle.resultPath), `worker wrote no result\nstderr: ${handle.stderr()}`);
  const result = JSON.parse(readFileSync(handle.resultPath, "utf8")) as
    | { ok: true; value: T }
    | { ok: false; error: string };
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return (result as { ok: true; value: T }).value;
}

async function runWorker<T>(action: string, args: string[]): Promise<T> {
  const handle = launchWorker(action, args);
  await waitForFile(handle.readyPath, `${action} worker readiness`);
  releaseGate(handle.gatePath);
  return collectWorker<T>(handle);
}

function record(id: string): archive.ArchiveRecord {
  return {
    id,
    paramsSha256: "f".repeat(64),
    request: { tokenAddress: "0xabc" },
    contentType: "text/html",
    deliverable: `report-${id}`,
    deliveredAt: new Date().toISOString(),
  };
}

function claimFiles(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(".tx-") && name.endsWith(".claim"));
}

function holdRecordLock(id: string): string {
  const lock = join(dir, `.record-${id.toLowerCase()}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(
    join(lock, "owner"),
    JSON.stringify({ pid: process.pid, startedAt: 1, token: `test-${randomUUID()}` }),
    { flag: "wx", mode: 0o600 },
  );
  return lock;
}

function releaseHeldLock(lock: string): void {
  unlinkSync(join(lock, "owner"));
  rmdirSync(lock);
}

beforeEach(() => {
  clean(dir);
  clean(controlDir);
  archive.resetIndex();
});

afterEach(async () => {
  const children = [...activeChildren];
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  })));
});

after(() => {
  archiveTemp.cleanup();
  controlTemp.cleanup();
  if (previousArchiveDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = previousArchiveDir;
  if (previousMacKey === undefined) delete process.env.ARCHIVE_MAC_KEY;
  else process.env.ARCHIVE_MAC_KEY = previousMacKey;
  if (previousMacRequired === undefined) delete process.env.ARCHIVE_MAC_REQUIRED;
  else process.env.ARCHIVE_MAC_REQUIRED = previousMacRequired;
  if (previousReplayKey === undefined) delete process.env.PAYMENT_REPLAY_KEY;
  else process.env.PAYMENT_REPLAY_KEY = previousReplayKey;
});

describe("cross-process transaction ownership", () => {
  test("standalone service lease is exclusive and a failed contender cannot remove it", async () => {
    const winnerGate = controlPath("service-lease-winner-gate");
    const contenderGate = controlPath("service-lease-contender-gate");
    const restoreSignal = controlPath("service-lease-restore");
    const restoredPath = controlPath("service-lease-restored");
    const winnerRelease = controlPath("service-lease-winner-release");
    const contenderRelease = controlPath("service-lease-contender-release");
    const winnerStatus = controlPath("service-lease-winner-status");
    const contenderStatus = controlPath("service-lease-contender-status");
    const winner = launchWorker(
      "acquire-lease-gap",
      [winnerStatus, restoreSignal, restoredPath, winnerRelease],
      winnerGate,
    );
    let contender: WorkerHandle | null = null;
    let restoreReleased = false;
    try {
      await waitForFile(winner.readyPath, "first service lease worker");
      releaseGate(winnerGate);
      await waitForFile(winnerStatus, "first service lease result");
      const winnerResult = JSON.parse(readFileSync(winnerStatus, "utf8")) as {
        acquired: boolean;
        pid: number;
      };
      assert.equal(winnerResult.acquired, true);

      contender = launchWorker("acquire-lease", [contenderStatus, contenderRelease], contenderGate);
      await waitForFile(contender.readyPath, "second service lease worker");
      releaseGate(contenderGate);
      await waitForFile(contenderStatus, "second service lease result");
      const contenderResult = JSON.parse(readFileSync(contenderStatus, "utf8")) as {
        acquired: boolean;
        pid: number;
      };
      assert.equal(contenderResult.acquired, false);

      const lease = join(dir, ".archive-service.lock");
      assert.equal(existsSync(lease), true, "a failed contender must not remove the winner's lease directory");
      assert.deepEqual(readdirSync(lease), []);
      releaseGate(restoreSignal);
      restoreReleased = true;
      await waitForFile(restoredPath, "first service lease restoration");
      const owners = readdirSync(lease);
      assert.equal(owners.length, 1);
      assert.match(owners[0]!, new RegExp(`^${winnerResult.pid}-`));
    } finally {
      if (!restoreReleased) releaseGateIfNeeded(restoreSignal);
      releaseGateIfNeeded(winnerGate);
      releaseGateIfNeeded(contenderGate);
      releaseGateIfNeeded(winnerRelease);
      releaseGateIfNeeded(contenderRelease);
      await collectWorker(winner);
      if (contender) await collectWorker(contender);
    }
    assert.equal(existsSync(join(dir, ".archive-service.lock")), false);
  });

  test("mixed-case forms of one transaction can have only one owner", async () => {
    const first = archive.newId();
    const second = archive.newId();
    const lower = `0x${"ab".repeat(32)}`;
    const upper = `0x${"AB".repeat(32)}`;
    assert.equal(archive.save(record(first)), true);
    assert.equal(archive.save(record(second)), true);

    const gate = controlPath("mixed-case-gate");
    const a = launchWorker("link", [first, lower], gate);
    const b = launchWorker("link", [second, upper], gate);
    await Promise.all([
      waitForFile(a.readyPath, "first mixed-case worker"),
      waitForFile(b.readyPath, "second mixed-case worker"),
    ]);
    releaseGate(gate);

    const [ra, rb] = await Promise.all([collectWorker<LinkResult>(a), collectWorker<LinkResult>(b)]);
    assert.deepEqual([ra.kind, rb.kind].sort(), ["linked", "transaction_conflict"]);
    const winnerId = ra.kind === "linked" ? first : second;
    assert.equal(ra.ownerId, winnerId);
    assert.equal(rb.ownerId, winnerId);
    assert.equal(archive.byTransaction(lower)?.id, winnerId);
    assert.equal(archive.byTransaction(upper)?.id, winnerId);
    assert.equal(claimFiles().length, 1);
  });

  test("a process with a cached miss sees a claim published by another process", async () => {
    const id = archive.newId();
    const tx = `0x${"34".repeat(32)}`;
    assert.equal(archive.save(record(id)), true);

    const lookup = launchWorker("lookup-after-miss", [tx]);
    await waitForFile(lookup.readyPath, "lookup worker's cached miss");
    const linked = await runWorker<LinkResult>("link", [id, tx]);
    assert.equal(linked.kind, "linked");
    releaseGate(lookup.gatePath);

    const seen = await collectWorker<{ firstId: string | null; secondId: string | null }>(lookup);
    assert.deepEqual(seen, { firstId: null, secondId: id });
  });

  test("one report cannot acquire two transactions in a race", async () => {
    const id = archive.newId();
    const firstTx = `0x${"56".repeat(32)}`;
    const secondTx = `0x${"78".repeat(32)}`;
    assert.equal(archive.save(record(id)), true);

    const gate = controlPath("two-transaction-gate");
    const a = launchWorker("link", [id, firstTx], gate);
    const b = launchWorker("link", [id, secondTx], gate);
    await Promise.all([
      waitForFile(a.readyPath, "first transaction worker"),
      waitForFile(b.readyPath, "second transaction worker"),
    ]);
    releaseGate(gate);

    const [ra, rb] = await Promise.all([collectWorker<LinkResult>(a), collectWorker<LinkResult>(b)]);
    assert.deepEqual([ra.kind, rb.kind].sort(), ["linked", "record_conflict"]);
    const winnerTx = ra.kind === "linked" ? firstTx : secondTx;
    const loserTx = ra.kind === "linked" ? secondTx : firstTx;
    assert.equal(archive.byTransaction(winnerTx)?.id, id);
    assert.equal(archive.byTransaction(loserTx), null);
    assert.equal(archive.byId(id)?.settlement?.transaction.toLowerCase(), winnerTx.toLowerCase());
    assert.equal(claimFiles().length, 1);
  });
});

describe("cross-process claim and cleanup", () => {
  test("simultaneous claim and discard cannot leave a dangling claim", async () => {
    const id = archive.newId();
    const tx = `0x${"9a".repeat(32)}`;
    assert.equal(archive.save(record(id)), true);

    const gate = controlPath("discard-gate");
    const linker = launchWorker("link", [id, tx], gate);
    const discarder = launchWorker("discard", [id], gate);
    await Promise.all([
      waitForFile(linker.readyPath, "claim worker"),
      waitForFile(discarder.readyPath, "discard worker"),
    ]);
    releaseGate(gate);

    const [linkResult, discardResult] = await Promise.all([
      collectWorker<LinkResult>(linker),
      collectWorker<{ discarded: boolean }>(discarder),
    ]);
    if (linkResult.kind === "linked") {
      assert.equal(discardResult.discarded, false);
      assert.equal(archive.byTransaction(tx)?.id, id);
      assert.equal(archive.byId(id)?.id, id);
      assert.equal(claimFiles().length, 1);
    } else {
      assert.equal(linkResult.kind, "record_missing");
      assert.equal(discardResult.discarded, true);
      assert.equal(archive.byTransaction(tx), null);
      assert.equal(archive.byId(id), null);
      assert.equal(claimFiles().length, 0);
    }
  });

  test("prune winning before a claim leaves no ownership sidecar", async () => {
    const id = archive.newId();
    const tx = `0x${"bc".repeat(32)}`;
    assert.equal(archive.save(record(id)), true);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${id}.json`), old, old);

    const heldRecordLock = holdRecordLock(id);
    const pruner = launchWorker("prune", []);
    await waitForFile(pruner.readyPath, "prune worker");
    releaseGate(pruner.gatePath);
    await waitForFile(join(dir, ".archive.lock", "owner"), "pruner to hold the archive lock");

    const linker = launchWorker("link", [id, tx]);
    await waitForFile(linker.readyPath, "blocked claim worker");
    releaseGate(linker.gatePath);
    releaseHeldLock(heldRecordLock);

    const [pruned, linked] = await Promise.all([
      collectWorker<{ saved: number }>(pruner),
      collectWorker<LinkResult>(linker),
    ]);
    assert.equal(pruned.saved, 25);
    assert.equal(linked.kind, "record_missing");
    assert.equal(archive.byId(id), null);
    assert.equal(archive.byTransaction(tx), null);
    assert.equal(claimFiles().length, 0);
  });

  test("a published claim protects an old record from another process's prune", async () => {
    const id = archive.newId();
    const tx = `0x${"de".repeat(32)}`;
    assert.equal(archive.save(record(id)), true);
    const linked = await runWorker<LinkResult>("link", [id, tx]);
    assert.equal(linked.kind, "linked");

    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${id}.json`), old, old);
    const pruned = await runWorker<{ saved: number }>("prune", []);

    assert.equal(pruned.saved, 25);
    assert.equal(archive.byTransaction(tx)?.id, id);
    assert.equal(archive.byId(id)?.id, id);
    assert.equal(claimFiles().length, 1);
  });

  test("an authenticated embedded settlement protects a migrated record without a claim", async () => {
    const id = archive.newId();
    const tx = `0x${"df".repeat(32)}`;
    assert.equal(
      archive.save({
        ...record(id),
        paymentTransaction: tx,
        settlement: {
          status: "confirmed",
          transaction: tx,
          network: "eip155:196",
          amount: "10000",
          payer: `0x${"13".repeat(20)}`,
        },
      }),
      true,
    );
    assert.equal(claimFiles().length, 0, "the fixture models a migrated embedded owner");
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${id}.json`), old, old);

    const pruned = await runWorker<{ saved: number }>("prune", []);

    assert.equal(pruned.saved, 25);
    archive.resetIndex();
    assert.equal(archive.byTransaction(tx)?.id, id);
    assert.equal(archive.byId(id)?.id, id);
    assert.equal(claimFiles().length, 0);
  });

  test("a replay hold protects an old report from age pruning", async () => {
    const id = archive.newId();
    assert.equal(archive.save(record(id)), true);
    const requirements: replay.ReplayRequirements = {
      scheme: "exact",
      network: "eip155:196",
      amount: "10000",
      asset: `0x${"05".repeat(20)}`,
      payTo: `0x${"06".repeat(20)}`,
    };
    const fingerprint = replayFingerprint(requirements);
    const begun = replay.begin(
      fingerprint,
      { paramsSha256: "c".repeat(64), contentType: "text/html" },
      requirements,
    );
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, id), true);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${id}.json`), old, old);

    const pruned = await runWorker<{ saved: number }>("prune", []);
    assert.equal(pruned.saved, 25);
    assert.equal(archive.byId(id)?.id, id);
  });

  test("a replay hold protects a report from the 5000-record capacity prune", async () => {
    const id = archive.newId();
    assert.equal(archive.save(record(id)), true);
    const requirements: replay.ReplayRequirements = {
      scheme: "exact",
      network: "eip155:196",
      amount: "10000",
      asset: `0x${"07".repeat(20)}`,
      payTo: `0x${"08".repeat(20)}`,
    };
    const fingerprint = replayFingerprint(requirements);
    const begun = replay.begin(
      fingerprint,
      { paramsSha256: "b".repeat(64), contentType: "text/html" },
      requirements,
    );
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, id), true);

    // Make the held record the oldest capacity candidate, then exceed the cap.
    // The 25th save after 4,999 fillers triggers pruning at 5,025 records.
    const oldest = new Date(Date.now() - 60_000);
    utimesSync(join(dir, `${id}.json`), oldest, oldest);
    // Seed authenticated unowned candidates directly so this boundary test
    // does not spend tens of seconds fsyncing 4,999 irrelevant bodies. Prune
    // reads ownership metadata and fails closed on malformed/authentication-
    // failing bytes, because either could be a damaged paid record.
    for (let i = 0; i < 4_999; i++) {
      const filler = record(randomUUID());
      writeFileSync(
        join(dir, `${filler.id}.json`),
        JSON.stringify({ ...filler, mac: archiveRecordMac(filler, MAC_KEY) }),
      );
    }

    const pruned = await runWorker<{ saved: number }>("prune", []);
    assert.equal(pruned.saved, 25);
    assert.equal(
      archive.byId(id)?.id,
      id,
      "capacity pressure must not evict the staged bytes of an unresolved payment",
    );
    assert.equal(
      readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith(".")).length,
      5_000,
      "capacity pruning must continue past a protected oldest candidate",
    );
  });

  test("replay attachment and prune cannot strand an attached payment", async () => {
    const id = archive.newId();
    assert.equal(archive.save(record(id)), true);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${id}.json`), old, old);

    const requirements: replay.ReplayRequirements = {
      scheme: "exact",
      network: "eip155:196",
      amount: "10000",
      asset: `0x${"01".repeat(20)}`,
      payTo: `0x${"02".repeat(20)}`,
    };
    const fingerprint = replayFingerprint(requirements);
    const begun = replay.begin(
      fingerprint,
      { paramsSha256: "f".repeat(64), contentType: "text/html" },
      requirements,
    );
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;

    const heldRecordLock = holdRecordLock(id);
    const gate = controlPath("hold-prune-gate");
    const pruner = launchWorker("prune", [], gate);
    const attacher = launchWorker(
      "attach-replay",
      [fingerprint, begun.attemptToken, id],
      gate,
    );
    await Promise.all([
      waitForFile(pruner.readyPath, "hold/prune worker"),
      waitForFile(attacher.readyPath, "replay attach worker"),
    ]);
    releaseGate(gate);
    await waitForFile(join(dir, ".archive.lock", "owner"), "pruner to hold archive lock");
    releaseHeldLock(heldRecordLock);

    const [pruned, attached] = await Promise.all([
      collectWorker<{ saved: number }>(pruner),
      collectWorker<{ attached: boolean }>(attacher),
    ]);
    assert.equal(pruned.saved, 25);
    if (attached.attached) {
      assert.equal(archive.byId(id)?.id, id, "an attached replay keeps its staged bytes");
      assert.equal(
        existsSync(join(dir, `.report-${id.toLowerCase()}.replay-hold`)),
        true,
      );
    } else {
      assert.equal(
        archive.byId(id),
        null,
        "if pruning wins, replay attachment fails instead of pointing at missing bytes",
      );
    }
  });

  test("definite release and prune coordinate on the record lock", async () => {
    const id = archive.newId();
    assert.equal(archive.save(record(id)), true);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${id}.json`), old, old);

    const requirements: replay.ReplayRequirements = {
      scheme: "exact",
      network: "eip155:196",
      amount: "10000",
      asset: `0x${"03".repeat(20)}`,
      payTo: `0x${"04".repeat(20)}`,
    };
    const fingerprint = replayFingerprint(requirements);
    const begun = replay.begin(
      fingerprint,
      { paramsSha256: "d".repeat(64), contentType: "text/html" },
      requirements,
    );
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") return;
    assert.equal(replay.attachReport(fingerprint, begun.attemptToken, id), true);

    const heldRecordLock = holdRecordLock(id);
    const gate = controlPath("release-prune-gate");
    const pruner = launchWorker("prune", [], gate);
    const releaser = launchWorker(
      "release-replay",
      [fingerprint, begun.attemptToken],
      gate,
    );
    await Promise.all([
      waitForFile(pruner.readyPath, "release/prune worker"),
      waitForFile(releaser.readyPath, "replay release worker"),
    ]);
    releaseGate(gate);
    await waitForFile(join(dir, ".archive.lock", "owner"), "pruner to hold archive lock");
    releaseHeldLock(heldRecordLock);

    const [pruned, released] = await Promise.all([
      collectWorker<{ saved: number }>(pruner),
      collectWorker<{ released: boolean }>(releaser),
    ]);
    assert.equal(pruned.saved, 25);
    assert.equal(released.released, true);
    assert.equal(
      existsSync(join(dir, `.report-${id.toLowerCase()}.replay-hold`)),
      false,
      "successful release leaves no dangling retention sidecar",
    );
    assert.equal(
      readdirSync(dir).some(
        (name) => name.startsWith(".payment-") && name.endsWith(".state"),
      ),
      false,
      "successful release removes replay ownership",
    );
    const candidate = archive.byId(id);
    if (candidate) {
      // The release may win only after this prune pass inspected the hold. In
      // that ordering the next maintenance pass removes the now-unprotected
      // old candidate; either outcome is correct so long as no payment state or
      // hold survives while the report is absent.
      const prunedAgain = await runWorker<{ saved: number }>("prune", []);
      assert.equal(prunedAgain.saved, 25);
    }
    assert.equal(
      archive.byId(id),
      null,
      "the old definitely-unpaid candidate is eligible by the next prune pass",
    );
    assert.equal(archive.readiness().ready, true);
  });
});
