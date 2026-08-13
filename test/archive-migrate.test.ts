import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import fs, {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { canonicalJson, sha256, type Attestation } from "../src/attest";
import {
  applyAndVerifyArchiveMigration,
  applyArchiveMigration,
  auditArchive,
  backupArchive,
  createArchiveApproval,
  createArchiveApprovalFromReview,
  createArchiveApprovalReview,
  readApproval,
  readApprovalReview,
  readBackupManifest,
  readPlan,
  verifyColdManifest,
  verifyBackupManifest,
  verifyPlan,
  verifyStrictArchive,
  writeJsonExclusive,
} from "../src/dossier/archive-migrate";
import {
  type ArchiveRecord,
  type TransactionClaim,
  archiveRecordDigest,
  archiveRecordMac,
  canonicalValue,
  legacyArchiveRecordMac,
  transactionClaimMac,
  transactionKey,
  validTransactionHash,
} from "../src/dossier/archive-format";
import { tempArchive } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const ARCHIVE_KEY = "archive-migration-test-key";
const OTHER_ARCHIVE_KEY = "other-archive-migration-test-key";
const REPLAY_KEY = "replay-migration-test-key";
const ARCHIVE_MODULE_URL = new URL("../src/dossier/archive.ts", import.meta.url).href;

function temp(): string {
  const { dir } = tempArchive();
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
  const id = overrides.id ?? "11111111-1111-4111-8111-111111111111";
  return {
    id,
    paramsSha256: "a".repeat(64),
    request: { tokenAddress: "0xabc" },
    contentType: "text/html",
    deliverable: "<html>legacy report</html>",
    deliveredAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function writeRecord(dir: string, value: ArchiveRecord): string {
  const path = join(dir, `${value.id}.json`);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

function writePrivate(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
}

function approveRecord(dir: string, rec: ArchiveRecord) {
  const path = `${rec.id}.json`;
  const digest = sha256(readFileSync(join(dir, path)));
  return createArchiveApproval(dir, [{ path, sha256: digest, reason: "matched immutable production backup" }], ARCHIVE_KEY);
}

function authenticatedRecord(overrides: Partial<ArchiveRecord> = {}, key = ARCHIVE_KEY): ArchiveRecord {
  const unsigned = record(overrides);
  return { ...unsigned, mac: archiveRecordMac(unsigned, key)! };
}

function replayMac(value: unknown, key = REPLAY_KEY): string {
  const derived = createHash("sha256").update(`dossier-payment-replay:${key}`).digest();
  return createHmac("sha256", derived).update(canonicalValue(value)).digest("hex");
}

function archiveReadinessScript(linger: boolean): string {
  return [
    `const archive = await import(${JSON.stringify(ARCHIVE_MODULE_URL)});`,
    "const lease = archive.acquireServiceLeaseForServer();",
    "const result = lease ? archive.readiness() : { ready: false, reason: 'archive directory unavailable' };",
    "process.stdout.write(JSON.stringify(result));",
    "if (!result.ready && process.env.EXPECT_ARCHIVE_READY === '1') process.exit(2);",
    linger ? "process.on('SIGTERM', () => { archive.releaseServiceLeaseAfterDrain(); process.exit(0); }); setInterval(() => {}, 1000);" : "",
  ].join("\n");
}

function archiveProcessEnv(dir: string, ready: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARCHIVE_DIR: dir,
    ARCHIVE_MAC_KEY: ARCHIVE_KEY,
    ARCHIVE_MAC_REQUIRED: "0",
    EXPECT_ARCHIVE_READY: ready ? "1" : "0",
  };
}

async function waitForPath(path: string, child: ChildProcess, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) {
      throw new Error(`archive service exited before taking its lease: ${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for archive service lease: ${stderr()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

describe("archive migration audit", () => {
  test("transaction hashing accepts only the exact canonical bytes", () => {
    const tx = `0x${"8".repeat(64)}`;
    assert.equal(validTransactionHash(tx), true);
    assert.equal(validTransactionHash(` ${tx}`), false);
    assert.equal(validTransactionHash(`${tx}\n`), false);
    assert.throws(() => transactionKey(` ${tx}`), /exact 32-byte/);
  });

  test("unsigned records require cryptographic evidence or an exact approval", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);

    const blocked = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.equal(blocked.counts.errors, 1);
    assert.equal(blocked.findings[0]?.code, "record_unapproved");

    const approval = approveRecord(dir, rec);
    const planned = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval });
    assert.equal(planned.counts.errors, 0);
    assert.equal(planned.changes.length, 1);
    assert.equal(planned.changes[0]?.evidence, "operator-approval");
  });

  test("signed JSON verifies content but still requires archive-metadata approval", () => {
    const dir = temp();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyB64 = (publicKey.export({ format: "jwk" }) as { x: string }).x;
    const body = { title: "Dossier", token: { chain: "x", address: "0xabc" } };
    const payload = {
      schemaVersion: "dossier-attestation/2",
      methodologyVersion: "engine/test",
      reportId: "report-evidence",
      requestSha256: "b".repeat(64),
      reportSha256: sha256(canonicalJson(body)),
      token: { chain: "x", address: "0xabc" },
      result: { verdict: "caution", coverage: 1, maxSizeUsd: null, checks: {} },
      observations: [],
      issuedAt: "2026-08-01T00:00:00.000Z",
      issuer: { agentId: 7012, name: "Dossier" },
    };
    const canonical = canonicalJson(payload);
    const attestation: Attestation = {
      payload,
      payloadSha256: sha256(canonical),
      signature: sign(null, Buffer.from(canonical), privateKey).toString("base64url"),
      publicKey: publicKeyB64,
      algorithm: "ed25519",
      verifyWith: "https://example.test/verify",
    };
    const rec = record({
      resolvedParamsSha256: payload.requestSha256,
      contentType: "application/json",
      deliverable: JSON.stringify({ ...body, attestation }),
    });
    writeRecord(dir, rec);

    const contentOnly = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, pinnedSigningKey: publicKeyB64 });
    assert.ok(contentOnly.findings.some((item) => item.code === "signed_json_content_verified"));
    assert.ok(contentOnly.findings.some((item) => item.code === "record_unapproved"));
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, pinnedSigningKey: publicKeyB64, approval: approveRecord(dir, rec) });
    assert.equal(plan.counts.errors, 0);
    assert.equal(plan.changes[0]?.evidence, "operator-approval");

    rec.deliverable = JSON.stringify({ ...body, title: "altered", attestation });
    writeRecord(dir, rec);
    const tampered = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, pinnedSigningKey: publicKeyB64 });
    assert.ok(tampered.findings.some((item) => item.code === "record_unapproved"));
  });

  test("legacy request-keyed records require an external cold archive", () => {
    const dir = temp();
    const hash = "c".repeat(64);
    writePrivate(join(dir, `${hash}.json`), JSON.stringify({
      paramsSha256: hash,
      request: { tokenAddress: "0xabc" },
      contentType: "text/html",
      deliverable: "<html>v1</html>",
      deliveredAt: "2026-07-01T00:00:00.000Z",
    }));
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.equal(plan.counts.errors, 1);
    assert.equal(plan.counts.legacyRecords, 1);
    assert.equal(plan.changes.length, 0);
    assert.ok(plan.findings.some((item) => item.code === "legacy_v1_cold_archive_required"));
    assert.throws(
      () => backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY),
      /blocking finding/,
    );
  });

  test("symlinks and ambiguous transaction ownership are blockers", () => {
    const dir = temp();
    const duplicate = `0x${"9".repeat(64)}`;
    const first = record({ id: "11111111-1111-4111-8111-111111111111", paymentTransaction: duplicate });
    const second = record({ id: "22222222-2222-4222-8222-222222222222", paymentTransaction: duplicate });
    writeRecord(dir, first);
    writeRecord(dir, second);
    symlinkSync(`${first.id}.json`, join(dir, "linked.json"));
    const approval = createArchiveApproval(dir, [first, second].map((rec) => ({
      path: `${rec.id}.json`,
      sha256: sha256(readFileSync(join(dir, `${rec.id}.json`))),
      reason: "fixture",
    })), ARCHIVE_KEY);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval });
    assert.ok(plan.findings.some((item) => item.code === "symlink"));
    assert.ok(plan.findings.some((item) => item.code === "ambiguous_transaction"));
  });

  test("group/world-readable archive files are migration blockers", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    const path = writeRecord(dir, rec);
    chmodSync(path, 0o644);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.ok(plan.findings.some((item) =>
      item.code === "archive_permissions" && item.path === `${rec.id}.json`
    ));
  });

  test("claims are signed before records without inventing missing ownership", () => {
    const dir = temp();
    const tx = `0x${"1".repeat(64)}`;
    const rec = record({ paymentTransaction: tx });
    writeRecord(dir, rec);
    const claim: TransactionClaim = {
      v: 1,
      transaction: tx,
      recordId: rec.id,
      recordDigest: archiveRecordDigest(rec),
    };
    writePrivate(join(dir, `.tx-${transactionKey(tx)}.claim`), JSON.stringify(claim));
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    assert.deepEqual(plan.changes.map((change) => change.kind), ["claim", "record"]);

    rmSync(join(dir, `.tx-${transactionKey(tx)}.claim`));
    const noClaim = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    assert.equal(noClaim.changes.filter((change) => change.kind === "claim").length, 0);
  });

  test("legacy MAC cannot authorize altered request or settlement metadata", () => {
    const tx = `0x${"2".repeat(64)}`;
    const settlement = {
      status: "confirmed" as const,
      transaction: tx,
      network: "eip155:196",
    };
    for (const [label, overrides] of [
      ["request", { request: { tokenAddress: "0xattacker" } }],
      ["settlement", { paymentTransaction: tx, settlement }],
    ] as const) {
      const dir = temp();
      const original = record(
        label === "settlement" ? { paymentTransaction: tx } : {},
      );
      const legacyMac = legacyArchiveRecordMac(original, OTHER_ARCHIVE_KEY)!;
      const altered = record({ ...overrides, mac: legacyMac });
      writeRecord(dir, altered);

      const blocked = auditArchive({
        archiveDir: dir,
        archiveMacKey: ARCHIVE_KEY,
        legacyArchiveMacKey: OTHER_ARCHIVE_KEY,
      });
      assert.ok(
        blocked.findings.some((item) => item.code === "legacy_record_mac_partial"),
        `${label}: legacy verification should be recorded as partial evidence`,
      );
      assert.ok(
        blocked.findings.some((item) => item.code === "record_unapproved"),
        `${label}: uncovered metadata must require exact approval`,
      );
      assert.equal(blocked.changes.length, 0);

      const approved = auditArchive({
        archiveDir: dir,
        archiveMacKey: ARCHIVE_KEY,
        legacyArchiveMacKey: OTHER_ARCHIVE_KEY,
        approval: approveRecord(dir, altered),
      });
      assert.equal(approved.counts.errors, 0);
      assert.equal(approved.changes[0]?.kind, "record");
      assert.equal(approved.changes[0]?.evidence, "operator-approval");
    }
  });

  test("unsigned claim cannot add settlement absent from the authenticated record", () => {
    const dir = temp();
    const tx = `0x${"5".repeat(64)}`;
    const rec = authenticatedRecord();
    writeRecord(dir, rec);
    const claim: TransactionClaim = {
      v: 1,
      transaction: tx,
      recordId: rec.id,
      recordDigest: archiveRecordDigest(rec),
      settlement: {
        status: "confirmed",
        transaction: tx,
        network: "eip155:196",
      },
    };
    const claimName = `.tx-${transactionKey(tx)}.claim`;
    const claimPath = join(dir, claimName);
    writePrivate(claimPath, JSON.stringify(claim));

    const blocked = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.ok(blocked.findings.some((item) => item.code === "claim_unapproved"));
    assert.equal(blocked.changes.length, 0);
    assert.deepEqual(createArchiveApprovalReview(blocked).files, [
      {
        path: claimName,
        sha256: sha256(readFileSync(claimPath)),
        actions: ["authenticate-claim"],
      },
    ]);

    const approval = createArchiveApproval(
      dir,
      [{
        path: claimName,
        sha256: sha256(readFileSync(claimPath)),
        reason: "verified settlement against external reconciliation evidence",
      }],
      ARCHIVE_KEY,
    );
    writeFileSync(
      claimPath,
      JSON.stringify({
        ...claim,
        settlement: { ...claim.settlement!, network: "eip155:1" },
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () => auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval }),
      /different archive snapshot/,
      "approval must remain bound to the exact unsigned claim bytes",
    );
    writeFileSync(claimPath, JSON.stringify(claim), { mode: 0o600 });
    const approved = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      approval,
    });
    assert.equal(approved.counts.errors, 0, JSON.stringify(approved.findings));
    assert.equal(approved.changes[0]?.kind, "claim");
    assert.equal(approved.changes[0]?.approvalRequired, true);
    assert.equal(approved.changes[0]?.evidence, "operator-approval");
  });

  test("existing record and claim MACs must verify with the selected archive key", () => {
    const dir = temp();
    const tx = `0x${"3".repeat(64)}`;
    const rec = authenticatedRecord({ paymentTransaction: tx }, OTHER_ARCHIVE_KEY);
    writeRecord(dir, rec);
    const unsignedClaim = {
      v: 1 as const,
      transaction: tx,
      recordId: rec.id,
      recordDigest: archiveRecordDigest(rec),
    };
    const claim = {
      ...unsignedClaim,
      mac: transactionClaimMac(unsignedClaim, OTHER_ARCHIVE_KEY)!,
    };
    writePrivate(join(dir, `.tx-${transactionKey(tx)}.claim`), JSON.stringify(claim));

    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.ok(plan.findings.some((item) => item.code === "record_mac_invalid"));
    assert.ok(plan.findings.some((item) => item.code === "claim_mac_invalid"));
    assert.equal(
      plan.changes.some((change) => change.path === `.tx-${transactionKey(tx)}.claim`),
      false,
      "an invalid existing claim MAC must never be replaced with a current one",
    );
  });

  test("claims must resolve to an existing record with the exact digest", () => {
    const dir = temp();
    const tx = `0x${"4".repeat(64)}`;
    const rec = authenticatedRecord({ paymentTransaction: tx });
    writeRecord(dir, rec);
    const claimPath = join(dir, `.tx-${transactionKey(tx)}.claim`);
    writePrivate(claimPath, JSON.stringify({
      v: 1,
      transaction: tx,
      recordId: "22222222-2222-4222-8222-222222222222",
      recordDigest: archiveRecordDigest(rec),
    } satisfies TransactionClaim));
    const dangling = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.ok(dangling.findings.some((item) => item.code === "claim_owner_mismatch"));

    writePrivate(claimPath, JSON.stringify({
      v: 1,
      transaction: tx,
      recordId: rec.id,
      recordDigest: "0".repeat(64),
    } satisfies TransactionClaim));
    const mismatched = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.ok(mismatched.findings.some((item) => item.code === "claim_owner_mismatch"));
  });

  test("padded transaction claims are invalid even when their MAC and filename agree", () => {
    const dir = temp();
    const tx = `0x${"6".repeat(64)}`;
    const padded = ` ${tx}`;
    const rec = authenticatedRecord({ paymentTransaction: tx });
    writeRecord(dir, rec);
    const unsigned = {
      v: 1 as const,
      transaction: padded,
      recordId: rec.id,
      recordDigest: archiveRecordDigest(rec),
    };
    const claim = { ...unsigned, mac: transactionClaimMac(unsigned, ARCHIVE_KEY)! };
    const claimName = `.tx-${createHash("sha256").update(padded.toLowerCase()).digest("hex")}.claim`;
    writePrivate(join(dir, claimName), JSON.stringify(claim));

    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.ok(
      plan.findings.some(
        (item) => item.code === "invalid_claim" && item.path === claimName,
      ),
      JSON.stringify(plan.findings),
    );
    assert.equal(
      plan.changes.some((change) => change.path === claimName),
      false,
      "migration must never authenticate a noncanonical ownership claim",
    );
  });

  test("padded transaction metadata is rejected before record approval or backfill", () => {
    const tx = `0x${"7".repeat(64)}`;
    for (const [label, overrides] of [
      ["payment", { paymentTransaction: `${tx} ` }],
      [
        "settlement",
        {
          paymentTransaction: tx,
          settlement: {
            status: "confirmed" as const,
            transaction: `\t${tx}`,
            network: "eip155:196",
          },
        },
      ],
    ] as const) {
      const dir = temp();
      const rec = record(overrides);
      writeRecord(dir, rec);
      const approval = approveRecord(dir, rec);
      const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval });

      assert.ok(
        plan.findings.some(
          (item) => item.code === "invalid_record" && item.path === `${rec.id}.json`,
        ),
        `${label}: ${JSON.stringify(plan.findings)}`,
      );
      assert.equal(plan.changes.length, 0, `${label}: invalid bytes must not be re-signed`);
      assert.equal(plan.counts.nonCanonicalTransactions, 0);
    }
  });

  test("audit rejects archive changes between its two scans", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    const recordPath = writeRecord(dir, rec);
    const originalReaddirSync = fs.readdirSync;
    let rootScans = 0;
    fs.readdirSync = ((path: Parameters<typeof fs.readdirSync>[0], options?: Parameters<typeof fs.readdirSync>[1]) => {
      const entries = originalReaddirSync(path, options as never);
      if (String(path) === dir && ++rootScans === 2) {
        writeFileSync(recordPath, `${JSON.stringify(rec)}\n`);
      }
      return entries;
    }) as typeof fs.readdirSync;
    syncBuiltinESMExports();
    try {
      const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
      assert.ok(plan.findings.some((item) => item.code === "unstable_inventory"));
    } finally {
      fs.readdirSync = originalReaddirSync;
      syncBuiltinESMExports();
    }
  });
});

describe("archive backup and apply", () => {
  test("verified backup gates an idempotent apply and strict verification", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    const backup = join(temp(), "snapshot");
    const manifest = backupArchive(plan, backup, ARCHIVE_KEY);

    const first = applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest);
    assert.deepEqual(first, {
      changed: 1,
      alreadyApplied: 0,
      legacyMoved: 0,
      legacyAlreadyMoved: 0,
      quarantineMoved: 0,
      quarantineAlreadyMoved: 0,
      coldManifest: null,
    });
    const stored = JSON.parse(readFileSync(join(dir, `${rec.id}.json`), "utf8")) as ArchiveRecord;
    assert.equal(stored.mac, archiveRecordMac(stored, ARCHIVE_KEY));

    const second = applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest);
    assert.deepEqual(second, {
      changed: 0,
      alreadyApplied: 1,
      legacyMoved: 0,
      legacyAlreadyMoved: 0,
      quarantineMoved: 0,
      quarantineAlreadyMoved: 0,
      coldManifest: null,
    });
    assert.equal(verifyStrictArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY }).counts.errors, 0);
  });

  test("combined apply and verification keeps migration ownership for the whole critical section", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      paymentReplayKey: REPLAY_KEY,
      approval: approveRecord(dir, rec),
    });
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY, {
      paymentReplayKey: REPLAY_KEY,
    });

    const originalReaddirSync = fs.readdirSync;
    let verificationObserved = false;
    fs.readdirSync = ((path: Parameters<typeof fs.readdirSync>[0], options?: Parameters<typeof fs.readdirSync>[1]) => {
      if (
        String(path) === dir &&
        existsSync(join(dir, ".archive-migration.lock")) &&
        existsSync(join(dir, ".archive.lock")) &&
        JSON.parse(readFileSync(join(dir, `${rec.id}.json`), "utf8")).mac
      ) {
        verificationObserved = true;
      }
      return originalReaddirSync(path, options as never);
    }) as typeof fs.readdirSync;
    syncBuiltinESMExports();
    try {
      const result = applyAndVerifyArchiveMigration(
        plan,
        manifest,
        { archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY },
        plan.planDigest,
      );
      assert.equal(result.apply.changed, 1);
      assert.equal(result.verification.counts.errors, 0);
      assert.equal(verificationObserved, true);
      assert.equal(existsSync(join(dir, ".archive-migration.lock")), false);
      assert.equal(existsSync(join(dir, ".archive.lock")), false);
    } finally {
      fs.readdirSync = originalReaddirSync;
      syncBuiltinESMExports();
    }
  });

  test("apply rejects an altered archive, wrong confirmation, and missing backup", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);
    assert.throws(() => applyArchiveMigration(plan, manifest, ARCHIVE_KEY, "wrong"), /exact plan digest/);
    writePrivate(join(dir, `${rec.id}.json`), "altered");
    assert.throws(() => applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest), /neither planned input nor output/);
    rmSync(manifest.backupPath, { recursive: true, force: true });
    assert.throws(() => applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest));
  });

  test("plan and backup manifest authentication rejects tampering and wrong keys", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);

    assert.throws(() => verifyPlan(plan, OTHER_ARCHIVE_KEY), /key fingerprint mismatch/);
    assert.throws(
      () => verifyPlan({ ...plan, createdAt: "2026-08-02T00:00:00.000Z" }, ARCHIVE_KEY),
      /plan digest does not match/,
    );
    assert.throws(
      () => verifyPlan({ ...plan, planMac: "0".repeat(64) }, ARCHIVE_KEY),
      /plan authentication failed/,
    );
    assert.throws(() => verifyBackupManifest(manifest, plan, OTHER_ARCHIVE_KEY), /key fingerprint mismatch/);
    assert.throws(
      () => verifyBackupManifest({ ...manifest, files: manifest.files + 1 }, plan, ARCHIVE_KEY),
      /backup manifest digest mismatch/,
    );
    assert.throws(
      () => verifyBackupManifest({ ...manifest, manifestMac: "0".repeat(64) }, plan, ARCHIVE_KEY),
      /backup manifest authentication failed/,
    );
  });

  test("migration artifact readers reject malformed and extra-field JSON", () => {
    const dir = temp();
    const paths = {
      plan: join(dir, "plan.json"),
      approval: join(dir, "approval.json"),
      review: join(dir, "review.json"),
      manifest: join(dir, "manifest.json"),
    };
    writeFileSync(paths.plan, "not json");
    assert.throws(() => readPlan(paths.plan), /not valid JSON/);
    for (const [path, read] of [
      [paths.plan, readPlan],
      [paths.approval, readApproval],
      [paths.review, readApprovalReview],
      [paths.manifest, readBackupManifest],
    ] as const) {
      writeFileSync(path, JSON.stringify({ unexpected: true }));
      assert.throws(() => read(path), /invalid shape/);
    }
  });

  test("exclusive artifact writes reject symlinked and non-private parents", () => {
    const privateDir = temp();
    const aliasRoot = temp();
    const alias = join(aliasRoot, "artifact-parent");
    symlinkSync(privateDir, alias);
    assert.throws(
      () => writeJsonExclusive(join(alias, "plan.json"), { ok: true }),
      /symlink|output parent changed/,
    );
    assert.equal(existsSync(join(privateDir, "plan.json")), false);

    const publicDir = temp();
    chmodSync(publicDir, 0o755);
    assert.throws(
      () => writeJsonExclusive(join(publicDir, "plan.json"), { ok: true }),
      /private directory/,
    );
    assert.equal(existsSync(join(publicDir, "plan.json")), false);
  });

  test("backup reuses the exact legacy and replay key context from audit", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    writeRecord(dir, rec);
    const plan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      legacyArchiveMacKey: OTHER_ARCHIVE_KEY,
      paymentReplayKey: REPLAY_KEY,
    });
    assert.throws(
      () => backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY),
      /legacy archive key fingerprint differs/,
    );
    assert.throws(
      () => backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY, {
        legacyArchiveMacKey: OTHER_ARCHIVE_KEY,
      }),
      /replay key fingerprint differs/,
    );
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY, {
      legacyArchiveMacKey: OTHER_ARCHIVE_KEY,
      paymentReplayKey: REPLAY_KEY,
    });
    assert.equal(manifest.planDigest, plan.planDigest);
  });

  test("backup destination must be disjoint from the active archive", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    assert.throws(
      () => backupArchive(plan, join(dir, "snapshot"), ARCHIVE_KEY),
      /outside and separate from ARCHIVE_DIR/,
    );
    assert.throws(
      () => backupArchive(plan, join(dir, ".."), ARCHIVE_KEY),
      /outside and separate from ARCHIVE_DIR/,
    );
    const alias = join(temp(), "archive-alias");
    symlinkSync(dir, alias);
    assert.throws(
      () => backupArchive(plan, join(alias, "snapshot"), ARCHIVE_KEY),
      /outside and separate from ARCHIVE_DIR/,
    );
  });

  test("strict verification is serialized against migration ownership", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    writeRecord(dir, rec);
    const result = verifyStrictArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.equal(result.counts.errors, 0);
    assert.equal(existsSync(join(dir, ".archive-migration.lock")), false);
  });

  test("strict verification rejects archive files with group/world permissions", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    const path = writeRecord(dir, rec);
    chmodSync(path, 0o644);
    assert.throws(
      () => verifyStrictArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY }),
      /strict verification failed:.*private|permissions/i,
    );
  });

  test("offline writer artifacts block backup and apply", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    mkdirSync(join(dir, ".payment-" + "a".repeat(64) + ".lock"));
    assert.throws(() => backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY), /writer artifacts/);
  });

  test("a live service lease blocks backup and apply", async () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);
    let stderr = "";
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", archiveReadinessScript(true)], {
      cwd: process.cwd(),
      env: archiveProcessEnv(dir, true),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    try {
      await waitForPath(join(dir, ".archive-service.lock"), child, () => stderr);
      assert.throws(
        () => backupArchive(plan, join(temp(), "blocked-snapshot"), ARCHIVE_KEY),
        /archive-service\.lock|service lease is present/,
      );
      assert.throws(
        () => applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest),
        /archive-service\.lock|service lease is present/,
      );
    } finally {
      await stopChild(child);
    }
  });

  test("a migration lock makes service startup fail closed", () => {
    const dir = temp();
    mkdirSync(join(dir, ".archive-migration.lock"));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", archiveReadinessScript(false)],
      { cwd: process.cwd(), env: archiveProcessEnv(dir, false), encoding: "utf8" },
    );
    if (result.error && (result.error as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const readiness = JSON.parse(result.stdout.trim()) as { ready: boolean; reason?: string };
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reason, "archive directory unavailable");
    assert.equal(existsSync(join(dir, ".archive-service.lock")), false);
  });

  test("legacy records move only to an approved checksummed cold archive", () => {
    const dir = temp();
    const hash = "c".repeat(64);
    writePrivate(join(dir, `${hash}.json`), JSON.stringify({
      paramsSha256: hash,
      request: { tokenAddress: "0xabc" },
      contentType: "text/html",
      deliverable: "<html>v1</html>",
      deliveredAt: "2026-07-01T00:00:00.000Z",
    }));
    const cold = join(temp(), "cold");
    const initial = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, coldArchiveDir: cold });
    const review = createArchiveApprovalReview(initial);
    assert.deepEqual(review.files[0]?.actions, ["move-legacy-to-cold-archive"]);
    const approval = createArchiveApprovalFromReview(
      dir,
      review,
      "reviewed historical request-keyed bytes",
      ARCHIVE_KEY,
    );
    const plan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      approval,
    });
    assert.equal(plan.counts.approvedLegacyRecords, 1);
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);
    const applied = applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest);
    assert.equal(applied.legacyMoved, 1);
    assert.ok(applied.coldManifest);
    assert.equal(existsSync(join(dir, `${hash}.json`)), false);
    assert.equal(existsSync(join(cold, `${hash}.json`)), true);
    assert.equal(verifyStrictArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY }).counts.errors, 0);

    const second = applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest);
    assert.equal(second.legacyAlreadyMoved, 1);
  });

  test("explicit unsigned and invalid-MAC current records quarantine with exact-byte evidence", () => {
    const dir = temp();
    const cold = join(temp(), "cold");
    const unsigned = record({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deliverable: "synthetic unsigned fixture",
    });
    const invalidMac = record({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deliverable: "synthetic invalid-MAC fixture",
      mac: "f".repeat(64),
    });
    const paths = [writeRecord(dir, unsigned), writeRecord(dir, invalidMac)];
    const selectors = paths.map((path, index) => ({
      path: `${index ? invalidMac.id : unsigned.id}.json`,
      sha256: sha256(readFileSync(path)),
      reason: index ? "known invalid-MAC load-test artifact" : "known unsigned smoke-test artifact",
    }));

    const initial = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      quarantineRecords: selectors,
    });
    assert.deepEqual(
      initial.quarantineDispositions.map((item) => item.validation),
      ["unsigned", "mac-invalid"],
    );
    assert.deepEqual(
      initial.quarantineDispositions.map((item) => item.observedMacSha256),
      [null, sha256(Buffer.from("f".repeat(64)))],
    );
    assert.equal(initial.changes.length, 0, "quarantine must never authenticate selected bytes");
    const review = createArchiveApprovalReview(initial);
    assert.deepEqual(
      review.files.map((item) => item.actions),
      [["quarantine-current-record"], ["quarantine-current-record"]],
    );
    assert.deepEqual(review.files.map((item) => item.reason), selectors.map((item) => item.reason));

    const approval = createArchiveApprovalFromReview(
      dir,
      review,
      "reviewed exact synthetic artifacts",
      ARCHIVE_KEY,
    );
    const plan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      approval,
    });
    assert.equal(plan.counts.errors, 0, JSON.stringify(plan.findings));
    assert.equal(plan.counts.approvedQuarantineRecords, 2);
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);
    const applied = applyAndVerifyArchiveMigration(
      plan,
      manifest,
      { archiveDir: dir, archiveMacKey: ARCHIVE_KEY },
      plan.planDigest,
    );
    assert.equal(applied.apply.quarantineMoved, 2);
    for (const selector of selectors) {
      assert.equal(existsSync(join(dir, selector.path)), false);
      assert.equal(sha256(readFileSync(join(cold, selector.path))), selector.sha256);
    }
    assert.deepEqual(
      applied.apply.coldManifest?.files.map((item) => ({
        path: item.path,
        disposition: item.disposition,
        reason: item.reason,
        validation: item.validation,
      })),
      plan.quarantineDispositions.map((item) => ({
        path: item.path,
        disposition: "quarantine-current-record",
        reason: item.reason,
        validation: item.validation,
      })),
    );
    const second = applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest);
    assert.equal(second.quarantineAlreadyMoved, 2);
  });

  test("quarantine selection and approval are exact, plan-bound, and path-safe", () => {
    const dir = temp();
    const cold = join(temp(), "cold");
    const rec = authenticatedRecord({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      deliverable: "known synthetic authenticated fixture",
    });
    const path = writeRecord(dir, rec);
    const selector = {
      path: `${rec.id}.json`,
      sha256: sha256(readFileSync(path)),
      reason: "known authenticated synthetic fixture",
    };
    const ordinary = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY });
    assert.equal(
      ordinary.quarantineDispositions.length,
      0,
      "the tool must never infer synthetic records from their content",
    );
    assert.throws(
      () => auditArchive({
        archiveDir: dir,
        archiveMacKey: ARCHIVE_KEY,
        coldArchiveDir: cold,
        quarantineRecords: [{ ...selector, path: `../${selector.path}` }],
      }),
      /unsafe relative path/,
    );
    assert.throws(
      () => auditArchive({
        archiveDir: dir,
        archiveMacKey: ARCHIVE_KEY,
        coldArchiveDir: cold,
        quarantineRecords: [{ ...selector, sha256: "0".repeat(64) }],
      }),
      /does not match an archive file/,
    );

    const manual = createArchiveApproval(dir, [selector], ARCHIVE_KEY);
    const manualPlan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      quarantineRecords: [selector],
      approval: manual,
    });
    assert.equal(manualPlan.counts.approvedQuarantineRecords, 0);
    assert.ok(manualPlan.findings.some((item) => item.code === "current_record_quarantine_unapproved"));

    const initial = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      quarantineRecords: [selector],
    });
    assert.equal(initial.quarantineDispositions[0]?.validation, "current-mac-valid");
    const review = createArchiveApprovalReview(initial);
    assert.throws(
      () => createArchiveApprovalFromReview(
        dir,
        {
          ...review,
          files: review.files.map((item) => ({
            ...item,
            actions: ["quarantine-current-record", "authenticate-record"],
          })),
        },
        "tampered action",
        ARCHIVE_KEY,
      ),
      /exclusive|altered/,
    );
    assert.throws(
      () => createArchiveApprovalFromReview(
        dir,
        {
          ...review,
          files: review.files.map((item) => ({ ...item, reason: "different reason" })),
        },
        "tampered reason",
        ARCHIVE_KEY,
      ),
      /digest no longer matches|altered/,
    );

    const approval = createArchiveApprovalFromReview(
      dir,
      review,
      "reviewed exact synthetic artifact",
      ARCHIVE_KEY,
    );
    const ordinaryApproval = createArchiveApproval(
      dir,
      [selector],
      ARCHIVE_KEY,
    );
    const forgedUnsigned = {
      version: ordinaryApproval.version,
      archivePath: ordinaryApproval.archivePath,
      inventoryDigest: ordinaryApproval.inventoryDigest,
      planDigest: review.reviewDigest,
      coldArchivePath: cold,
      approvedFiles: ordinaryApproval.approvedFiles,
    };
    const forgedDigest = sha256(canonicalValue(forgedUnsigned));
    const forgedDerived = createHash("sha256")
      .update(`dossier-archive-approval:${ARCHIVE_KEY}`)
      .digest();
    const forgedApproval = {
      ...forgedUnsigned,
      approvalDigest: forgedDigest,
      approvalMac: createHmac("sha256", forgedDerived).update(forgedDigest).digest("hex"),
    };
    const forgedPlan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      quarantineRecords: [selector],
      approval: forgedApproval,
    });
    assert.equal(forgedPlan.counts.approvedQuarantineRecords, 0);
    assert.ok(forgedPlan.findings.some((item) => item.code === "current_record_quarantine_unapproved"));
    assert.throws(
      () => auditArchive({
        archiveDir: dir,
        archiveMacKey: ARCHIVE_KEY,
        coldArchiveDir: cold,
        quarantineRecords: [{ ...selector, reason: "different reason" }],
        approval,
      }),
      /differ from the plan-bound approval/,
    );
  });

  test("quarantine rejects unrecognized JSON, collisions, tamper, and resumes prepared copies", () => {
    const dir = temp();
    const cold = join(temp(), "cold");
    const rec = record({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      deliverable: "known synthetic crash fixture",
    });
    const path = writeRecord(dir, rec);
    const selector = {
      path: `${rec.id}.json`,
      sha256: sha256(readFileSync(path)),
      reason: "known crash-test artifact",
    };
    const initial = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      quarantineRecords: [selector],
    });
    const approval = createArchiveApprovalFromReview(
      dir,
      createArchiveApprovalReview(initial),
      "reviewed crash fixture",
      ARCHIVE_KEY,
    );
    const plan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: cold,
      approval,
    });
    const backup = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);
    const first = applyArchiveMigration(plan, backup, ARCHIVE_KEY, plan.planDigest);
    assert.ok(first.coldManifest);

    const manifestPath = join(cold, ".dossier-cold-archive-manifest.json");
    const prepared = remacColdManifest({ ...first.coldManifest!, status: "prepared" }, ARCHIVE_KEY);
    writePrivate(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
    const coldBytes = readFileSync(join(cold, selector.path));
    writePrivate(path, coldBytes);
    const copyTemp = join(
      cold,
      `.dossier-cold-copy-${sha256(Buffer.from(`${plan.planDigest}\0${selector.path}`))}.tmp`,
    );
    writePrivate(copyTemp, coldBytes);
    const manifestTemp = join(cold, `.dossier-cold-manifest-${plan.planDigest}.tmp`);
    writePrivate(manifestTemp, '{"partialCompleteManifest":');
    rmSync(join(cold, selector.path));
    const resumed = applyArchiveMigration(plan, backup, ARCHIVE_KEY, plan.planDigest);
    assert.equal(resumed.quarantineMoved, 1);
    assert.equal(resumed.coldManifest?.status, "complete");
    assert.equal(existsSync(copyTemp), false);
    assert.equal(existsSync(manifestTemp), false);

    writePrivate(join(cold, selector.path), "tampered bytes");
    assert.throws(
      () => verifyColdManifest(resumed.coldManifest!, plan, ARCHIVE_KEY),
      /no longer matches its manifest/,
    );

    const malformedDir = temp();
    const malformedName = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.json";
    const malformedPath = join(malformedDir, malformedName);
    writePrivate(malformedPath, JSON.stringify({ id: malformedName.slice(0, -5), hello: "world" }));
    const malformed = auditArchive({
      archiveDir: malformedDir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: join(temp(), "cold"),
      quarantineRecords: [{
        path: malformedName,
        sha256: sha256(readFileSync(malformedPath)),
        reason: "claimed synthetic fixture",
      }],
    });
    assert.ok(malformed.findings.some((item) => item.code === "quarantine_record_unrecognized"));

    const collisionDir = temp();
    const collisionCold = join(temp(), "cold");
    const collisionRecord = record({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      deliverable: "known collision fixture",
    });
    const collisionPath = writeRecord(collisionDir, collisionRecord);
    const collisionSelector = {
      path: `${collisionRecord.id}.json`,
      sha256: sha256(readFileSync(collisionPath)),
      reason: "known collision-test artifact",
    };
    const collisionAudit = auditArchive({
      archiveDir: collisionDir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: collisionCold,
      quarantineRecords: [collisionSelector],
    });
    const collisionApproval = createArchiveApprovalFromReview(
      collisionDir,
      createArchiveApprovalReview(collisionAudit),
      "reviewed collision fixture",
      ARCHIVE_KEY,
    );
    const collisionPlan = auditArchive({
      archiveDir: collisionDir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: collisionCold,
      approval: collisionApproval,
    });
    const collisionBackup = backupArchive(
      collisionPlan,
      join(temp(), "snapshot"),
      ARCHIVE_KEY,
    );
    mkdirSync(collisionCold, { mode: 0o700 });
    writePrivate(join(collisionCold, collisionSelector.path), "different existing cold bytes");
    assert.throws(
      () => applyArchiveMigration(
        collisionPlan,
        collisionBackup,
        ARCHIVE_KEY,
        collisionPlan.planDigest,
      ),
      /unexpected or unsafe cold archive entry|checksum mismatch/,
    );
    assert.equal(
      sha256(readFileSync(collisionPath)),
      collisionSelector.sha256,
      "a cold collision must leave the active source untouched",
    );
  });

  test("manual approval cannot authorize legacy cold-archive movement", () => {
    const dir = temp();
    const hash = "d".repeat(64);
    const name = `${hash}.json`;
    writePrivate(join(dir, name), JSON.stringify({
      paramsSha256: hash,
      request: { tokenAddress: "0xabc" },
      contentType: "text/html",
      deliverable: "<html>v1</html>",
      deliveredAt: "2026-07-01T00:00:00.000Z",
    }));
    const approval = createArchiveApproval(dir, [{
      path: name,
      sha256: sha256(readFileSync(join(dir, name))),
      reason: "manual per-file approval",
    }], ARCHIVE_KEY);
    const plan = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      coldArchiveDir: join(temp(), "cold"),
      approval,
    });
    assert.equal(plan.counts.approvedLegacyRecords, 0);
    assert.ok(plan.findings.some((item) => item.code === "legacy_v1_cold_archive_unapproved"));
    assert.throws(
      () => backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY),
      /blocking finding/,
    );
  });

  test("prepared cold manifest resumes safely after a partial move", () => {
    const fixture = prepareLegacyMigration("4");
    const firstName = fixture.names[0]!;
    const secondName = fixture.names[1]!;
    const firstApply = applyArchiveMigration(fixture.plan, fixture.manifest, ARCHIVE_KEY, fixture.plan.planDigest);
    assert.equal(firstApply.legacyMoved, 2);

    const coldManifestPath = join(fixture.cold, ".dossier-cold-archive-manifest.json");
    const complete = JSON.parse(readFileSync(coldManifestPath, "utf8"));
    const prepared = remacColdManifest({ ...complete, status: "prepared" }, ARCHIVE_KEY);
    writeFileSync(coldManifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
    writePrivate(join(fixture.dir, secondName), readFileSync(join(fixture.cold, secondName)));

    const resumed = applyArchiveMigration(fixture.plan, fixture.manifest, ARCHIVE_KEY, fixture.plan.planDigest);
    assert.equal(resumed.legacyMoved, 1);
    assert.equal(resumed.legacyAlreadyMoved, 1);
    assert.equal(resumed.coldManifest?.status, "complete");
    assert.equal(existsSync(join(fixture.dir, firstName)), false);
    assert.equal(existsSync(join(fixture.dir, secondName)), false);
  });

  test("cold manifest rejects wrong keys, tampering, and missing completed files", () => {
    const fixture = prepareLegacyMigration("5");
    const applied = applyArchiveMigration(fixture.plan, fixture.manifest, ARCHIVE_KEY, fixture.plan.planDigest);
    assert.ok(applied.coldManifest);
    assert.throws(
      () => verifyColdManifest(applied.coldManifest!, fixture.plan, OTHER_ARCHIVE_KEY),
      /authentication failed/,
    );
    assert.throws(
      () => verifyColdManifest({ ...applied.coldManifest!, status: "prepared" }, fixture.plan, ARCHIVE_KEY, true),
      /digest mismatch/,
    );
    rmSync(join(fixture.cold, fixture.names[0]!));
    assert.throws(
      () => verifyColdManifest(applied.coldManifest!, fixture.plan, ARCHIVE_KEY),
      /no longer matches its manifest/,
    );
  });

  test("cold manifest verification rejects accessible directories, files, and manifest", () => {
    for (const target of ["directory", "file", "manifest"] as const) {
      const fixture = prepareLegacyMigration(target === "directory" ? "0" : target === "file" ? "1" : "2");
      const applied = applyArchiveMigration(fixture.plan, fixture.manifest, ARCHIVE_KEY, fixture.plan.planDigest);
      assert.ok(applied.coldManifest);
      const path = target === "directory"
        ? fixture.cold
        : target === "file"
          ? join(fixture.cold, fixture.names[0]!)
          : join(fixture.cold, ".dossier-cold-archive-manifest.json");
      chmodSync(path, target === "directory" ? 0o755 : 0o644);
      assert.throws(
        () => verifyColdManifest(applied.coldManifest!, fixture.plan, ARCHIVE_KEY),
        /group-|world-accessible|private regular file/,
      );
    }
  });

  test("cold archive rejects extra files, symlinks, and special entries", () => {
    for (const kind of ["file", "symlink", "special"] as const) {
      const fixture = prepareLegacyMigration(kind === "file" ? "6" : kind === "symlink" ? "7" : "8");
      if (kind === "file") {
        writeFileSync(join(fixture.cold, "unexpected.txt"), "unexpected");
      } else if (kind === "symlink") {
        symlinkSync(fixture.dir, join(fixture.cold, "unexpected-link"));
      } else {
        const fifo = spawnSync("mkfifo", [join(fixture.cold, "unexpected-fifo")]);
        assert.equal(fifo.status, 0, fifo.stderr?.toString());
      }
      assert.throws(
        () => applyArchiveMigration(fixture.plan, fixture.manifest, ARCHIVE_KEY, fixture.plan.planDigest),
        /unexpected or unsafe cold archive entry/,
      );
    }
  });

  test("cold archive path cannot resolve through a symlink into ARCHIVE_DIR", () => {
    const dir = temp();
    const hash = "9".repeat(64);
    writePrivate(join(dir, `${hash}.json`), JSON.stringify({
      paramsSha256: hash,
      request: { tokenAddress: "0xabc" },
      contentType: "text/html",
      deliverable: "<html>v1</html>",
      deliveredAt: "2026-07-01T00:00:00.000Z",
    }));
    const alias = join(temp(), "archive-alias");
    symlinkSync(dir, alias);
    assert.throws(
      () => auditArchive({
        archiveDir: dir,
        archiveMacKey: ARCHIVE_KEY,
        coldArchiveDir: join(alias, "cold"),
      }),
      /outside and separate from ARCHIVE_DIR/,
    );
  });

  test("strict verification with a plan rejects different authenticated final bytes", () => {
    const dir = temp();
    const rec = record();
    writeRecord(dir, rec);
    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, approval: approveRecord(dir, rec) });
    const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);
    applyArchiveMigration(plan, manifest, ARCHIVE_KEY, plan.planDigest);

    const altered = authenticatedRecord({ ...rec, deliverable: "<html>different valid report</html>", mac: undefined });
    writeRecord(dir, altered);
    assert.equal(verifyStrictArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY }).counts.errors, 0);
    assert.throws(
      () => verifyStrictArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY }, plan),
      /planned final state/,
    );
  });

  test("strict verification rejects active legacy v1 records", () => {
    const dir = temp();
    const hash = "e".repeat(64);
    writePrivate(join(dir, `${hash}.json`), JSON.stringify({
      paramsSha256: hash,
      request: { tokenAddress: "0xabc" },
      contentType: "text/html",
      deliverable: "<html>v1</html>",
      deliveredAt: "2026-07-01T00:00:00.000Z",
    }));
    assert.throws(
      () => verifyStrictArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY }),
      /strict_incomplete/,
    );
  });
});

function prepareLegacyMigration(seed: string, createCold = true): {
  dir: string;
  cold: string;
  names: string[];
  plan: ReturnType<typeof auditArchive>;
  manifest: ReturnType<typeof backupArchive>;
} {
  const dir = temp();
  const names = [seed.repeat(64), `${seed}${seed === "f" ? "e" : "f"}`.repeat(32)].map((hash) => `${hash}.json`);
  for (const name of names) {
    const hash = name.slice(0, -5);
    writePrivate(join(dir, name), JSON.stringify({
      paramsSha256: hash,
      request: { tokenAddress: "0xabc" },
      contentType: "text/html",
      deliverable: `<html>${hash.slice(0, 4)}</html>`,
      deliveredAt: "2026-07-01T00:00:00.000Z",
    }));
  }
  const cold = join(temp(), "cold");
  if (createCold) mkdirSync(cold, { mode: 0o700 });
  const initial = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, coldArchiveDir: cold });
  const approval = createArchiveApprovalFromReview(
    dir,
    createArchiveApprovalReview(initial),
    "reviewed historical request-keyed bytes",
    ARCHIVE_KEY,
  );
  const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, coldArchiveDir: cold, approval });
  const manifest = backupArchive(plan, join(temp(), "snapshot"), ARCHIVE_KEY);
  return { dir, cold, names, plan, manifest };
}

function remacColdManifest(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const { manifestDigest: _digest, manifestMac: _mac, ...unsigned } = value;
  const manifestDigest = sha256(canonicalValue(unsigned));
  const derived = createHash("sha256").update(`dossier-archive-cold-manifest:${key}`).digest();
  const manifestMac = createHmac("sha256", derived).update(manifestDigest).digest("hex");
  return { ...unsigned, manifestDigest, manifestMac };
}

describe("payment replay audit", () => {
  test("replay states require canonical timestamps and complete process ownership", () => {
    const dir = temp();
    const base = {
      v: 1 as const,
      status: "pending" as const,
      attemptToken: "c".repeat(32),
      request: { paramsSha256: "d".repeat(64), contentType: "text/html" as const },
      requirements: { scheme: "exact", network: "eip155:196", amount: "10000", asset: "USDT0", payTo: "0xpay" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
    };
    const noncanonicalFingerprint = "1".repeat(64);
    const noncanonical = {
      ...base,
      fingerprint: noncanonicalFingerprint,
      createdAt: "2026-08-01T00:00:00Z",
    };
    writeFileSync(
      join(dir, `.payment-${noncanonicalFingerprint}.state`),
      JSON.stringify({ ...noncanonical, mac: replayMac(noncanonical) }),
    );

    const partialOwnerFingerprint = "2".repeat(64);
    const partialOwner = {
      ...base,
      fingerprint: partialOwnerFingerprint,
      ownerPid: 123,
    };
    writeFileSync(
      join(dir, `.payment-${partialOwnerFingerprint}.state`),
      JSON.stringify({ ...partialOwner, mac: replayMac(partialOwner) }),
    );

    const nonStringTokenFingerprint = "3".repeat(64);
    const nonStringToken = {
      ...base,
      fingerprint: nonStringTokenFingerprint,
      attemptToken: ["c".repeat(32)],
    };
    writeFileSync(
      join(dir, `.payment-${nonStringTokenFingerprint}.state`),
      JSON.stringify({ ...nonStringToken, mac: replayMac(nonStringToken) }),
    );

    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY });
    const invalid = plan.findings.filter((item) => item.code === "invalid_replay_state");
    assert.deepEqual(
      invalid.map((item) => item.path).sort(),
      [
        `.payment-${noncanonicalFingerprint}.state`,
        `.payment-${partialOwnerFingerprint}.state`,
        `.payment-${nonStringTokenFingerprint}.state`,
      ],
    );
  });

  test("malformed replay states and holds are blockers", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    writeRecord(dir, rec);
    const fingerprint = "b".repeat(64);
    const attemptToken = "c".repeat(32);
    const stateBase = {
      v: 1 as const,
      fingerprint,
      status: "pending" as const,
      attemptToken,
      request: { paramsSha256: "d".repeat(64), contentType: "text/html" as const },
      requirements: { scheme: "exact", network: "eip155:196", amount: "10000", asset: "USDT0", payTo: "0xpay" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
      reportId: rec.id,
    };
    writePrivate(join(dir, `.payment-${fingerprint}.state`), JSON.stringify({
      ...stateBase,
      mac: replayMac(stateBase, OTHER_ARCHIVE_KEY),
    }));
    const holdBase = { v: 1 as const, reportId: rec.id, fingerprint, attemptToken };
    writePrivate(join(dir, `.report-${rec.id}.replay-hold`), JSON.stringify({
      ...holdBase,
      mac: "0".repeat(64),
    }));

    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY });
    assert.ok(plan.findings.some((item) => item.code === "invalid_replay_state"));
    assert.ok(plan.findings.some((item) => item.code === "invalid_replay_hold"));
  });

  test("MAC-valid non-string replay hold identifiers are rejected", () => {
    const dir = temp();
    const fingerprint = "7".repeat(64);
    const attemptToken = "8".repeat(32);
    const reportId = "44444444-4444-4444-8444-444444444444";
    const unsigned = { v: 1 as const, reportId, fingerprint, attemptToken };
    const hold = {
      ...unsigned,
      reportId: [reportId],
      mac: replayMac({ ...unsigned, reportId: [reportId] }),
    };
    writePrivate(join(dir, `.report-${reportId}.replay-hold`), JSON.stringify(hold));

    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY });
    assert.ok(plan.findings.some((item) => item.code === "invalid_replay_hold"));
  });

  test("replay holds must match their report and replay state", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    writeRecord(dir, rec);
    const fingerprint = "6".repeat(64);
    const attemptToken = "7".repeat(32);
    const stateBase = {
      v: 1 as const,
      fingerprint,
      status: "unknown" as const,
      attemptToken,
      request: { paramsSha256: "8".repeat(64), contentType: "application/json" as const },
      requirements: { scheme: "exact", network: "eip155:196", amount: "10000", asset: "USDT0", payTo: "0xpay" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
      reportId: rec.id,
      reason: "settlement_timeout" as const,
    };
    writePrivate(join(dir, `.payment-${fingerprint}.state`), JSON.stringify({
      ...stateBase,
      mac: replayMac(stateBase),
    }));
    const holdBase = {
      v: 1 as const,
      reportId: rec.id,
      fingerprint,
      attemptToken: "9".repeat(32),
    };
    writePrivate(join(dir, `.report-${rec.id}.replay-hold`), JSON.stringify({
      ...holdBase,
      mac: replayMac(holdBase),
    }));

    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY });
    assert.ok(plan.findings.some((item) => item.code === "replay_hold_owner_mismatch"));
  });

  test("timeout settlement evidence is accepted only as an unknown candidate", () => {
    const dir = temp();
    const rec = authenticatedRecord();
    writeRecord(dir, rec);
    const fingerprint = "9".repeat(64);
    const attemptToken = "a".repeat(32);
    const settlement = {
      transaction: `0x${"4".repeat(64)}`,
      network: "eip155:196",
      amount: "10000",
    };
    const candidate = {
      v: 1 as const,
      fingerprint,
      status: "unknown" as const,
      attemptToken,
      request: { paramsSha256: "b".repeat(64), contentType: "text/html" as const },
      requirements: {
        scheme: "exact",
        network: "eip155:196",
        amount: "10000",
        asset: "USDT0",
        payTo: "0xpay",
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
      reportId: rec.id,
      reason: "settlement_timeout" as const,
      settlement,
      settlementEvidence: "candidate" as const,
    };
    writePrivate(
      join(dir, `.payment-${fingerprint}.state`),
      JSON.stringify({ ...candidate, mac: replayMac(candidate) }),
    );
    const hold = { v: 1 as const, reportId: rec.id, fingerprint, attemptToken };
    writePrivate(
      join(dir, `.report-${rec.id}.replay-hold`),
      JSON.stringify({ ...hold, mac: replayMac(hold) }),
    );

    const clean = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      paymentReplayKey: REPLAY_KEY,
    });
    assert.equal(clean.counts.errors, 0);

    const statePath = join(dir, `.payment-${fingerprint}.state`);
    const invalid = {
      ...candidate,
      settlementEvidence: "confirmed" as const,
    };
    writePrivate(statePath, JSON.stringify({ ...invalid, mac: replayMac(invalid) }));
    const broken = auditArchive({
      archiveDir: dir,
      archiveMacKey: ARCHIVE_KEY,
      paymentReplayKey: REPLAY_KEY,
    });
    assert.ok(broken.findings.some((item) => item.code === "invalid_replay_state"));
  });

  test("confirmed replay state must resolve to its settled archive owner", () => {
    const dir = temp();
    const tx = `0x${"2".repeat(64)}`;
    const settlement = { status: "confirmed" as const, transaction: tx, network: "eip155:196" };
    const unsignedRecord = record({ paymentTransaction: tx, settlement });
    const rec = { ...unsignedRecord, mac: archiveRecordMac(unsignedRecord, ARCHIVE_KEY)! };
    writeRecord(dir, rec);
    const unsignedClaim = { v: 1 as const, transaction: tx, recordId: rec.id, recordDigest: archiveRecordDigest(rec), settlement };
    const claim = { ...unsignedClaim, mac: transactionClaimMac(unsignedClaim, ARCHIVE_KEY)! };
    writePrivate(join(dir, `.tx-${transactionKey(tx)}.claim`), JSON.stringify(claim));

    const fingerprint = "d".repeat(64);
    const stateBase = {
      v: 1 as const,
      fingerprint,
      status: "confirmed" as const,
      attemptToken: "e".repeat(32),
      request: { paramsSha256: "f".repeat(64), contentType: "text/html" as const },
      requirements: { scheme: "exact", network: "eip155:196", amount: "10000", asset: "USDT0", payTo: "0xpay" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
      reportId: rec.id,
      settlement: { transaction: tx, network: "eip155:196" },
    };
    const state = { ...stateBase, mac: replayMac(stateBase) };
    writePrivate(join(dir, `.payment-${fingerprint}.state`), JSON.stringify(state));

    const clean = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY });
    assert.equal(clean.counts.errors, 0);

    state.reportId = "22222222-2222-4222-8222-222222222222";
    const { mac: _mac, ...tamperedBase } = state;
    state.mac = replayMac(tamperedBase);
    writePrivate(join(dir, `.payment-${fingerprint}.state`), JSON.stringify(state));
    const broken = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY });
    assert.ok(broken.findings.some((item) => item.code === "replay_report_missing"));
  });

  test("whitespace-padded replay settlement is rejected as noncanonical", () => {
    const dir = temp();
    const tx = `0x${"3".repeat(64)}`;
    const padded = ` ${tx}`;
    const fingerprint = "4".repeat(64);
    const stateBase = {
      v: 1 as const,
      fingerprint,
      status: "confirmed" as const,
      attemptToken: "5".repeat(32),
      request: { paramsSha256: "6".repeat(64), contentType: "text/html" as const },
      requirements: { scheme: "exact", network: "eip155:196", amount: "10000", asset: "USDT0", payTo: "0xpay" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
      reportId: "33333333-3333-4333-8333-333333333333",
      settlement: { transaction: padded, network: "eip155:196" },
    };
    writeFileSync(
      join(dir, `.payment-${fingerprint}.state`),
      JSON.stringify({ ...stateBase, mac: replayMac(stateBase) }),
    );

    const plan = auditArchive({ archiveDir: dir, archiveMacKey: ARCHIVE_KEY, paymentReplayKey: REPLAY_KEY });
    assert.ok(plan.findings.some((item) => item.code === "invalid_replay_state"));
  });
});
