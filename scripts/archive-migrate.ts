#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

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
  type QuarantineSelector,
  verifyStrictArchive,
  writeJsonExclusive,
} from "../src/dossier/archive-migrate";

const args = process.argv.slice(2);
const command = args[0]?.startsWith("-") || !args[0] ? "audit" : args.shift()!;

try {
  const flags = parseFlags(args, command);
  const archiveDir = flags.archive || process.env.ARCHIVE_DIR || resolve(process.env.HOME || process.env.TMPDIR || "/tmp", ".dossier-archive");
  const archiveMacKey = secret("ARCHIVE_MAC_KEY");
  const legacyArchiveMacKey = secret("ARCHIVE_LEGACY_MAC_KEY");
  const paymentReplayKey = secret("PAYMENT_REPLAY_KEY");
  const pinnedSigningKey = flags["signing-public-key"] || process.env.DOSSIER_SIGNING_PUBLIC_KEY;
  rejectArchiveOutputPaths(command, flags, archiveDir);
  switch (command) {
    case "audit": {
      const quarantineRecords = values(flags.quarantine).map(parseQuarantine);
      const plan = auditArchive({
        archiveDir,
        archiveMacKey,
        legacyArchiveMacKey,
        paymentReplayKey,
        pinnedSigningKey,
        coldArchiveDir: flags["cold-archive-dir"],
        ...(quarantineRecords.length ? { quarantineRecords } : {}),
        ...(flags.approval ? { approval: readApproval(flags.approval) } : {}),
      });
      if (flags.out) writeJsonExclusive(flags.out, plan);
      if (flags["approval-review-out"]) {
        writeJsonExclusive(flags["approval-review-out"], createArchiveApprovalReview(plan));
      }
      printPlan(plan, flags.out);
      process.exitCode = plan.counts.errors ? 2 : 0;
      break;
    }
    case "approve": {
      requireValue(flags.out, "--out");
      requireSecret(archiveMacKey, "ARCHIVE_MAC_KEY");
      const files = values(flags.approve);
      if (!files.length) throw new Error("approve requires at least one --approve path:sha256:reason");
      const approval = createArchiveApproval(
        archiveDir,
        files.map(parseApproval),
        archiveMacKey,
      );
      writeJsonExclusive(flags.out!, approval);
      console.log(`approval: ${resolve(flags.out!)}\napprovalDigest: ${approval.approvalDigest}\nfiles: ${approval.approvedFiles.length}`);
      break;
    }
    case "approve-review": {
      requireValue(flags.review, "--review");
      requireValue(flags.reason, "--reason");
      requireValue(flags.out, "--out");
      requireSecret(archiveMacKey, "ARCHIVE_MAC_KEY");
      const review = readApprovalReview(flags.review!);
      const approval = createArchiveApprovalFromReview(
        archiveDir,
        review,
        flags.reason!,
        archiveMacKey,
        { legacyArchiveMacKey, paymentReplayKey, pinnedSigningKey },
      );
      writeJsonExclusive(flags.out!, approval);
      console.log(`approval: ${resolve(flags.out!)}\napprovalDigest: ${approval.approvalDigest}\nfiles: ${approval.approvedFiles.length}`);
      break;
    }
    case "backup": {
      requireValue(flags.plan, "--plan");
      requireValue(flags.out, "--out");
      requireValue(flags["backup-dir"], "--backup-dir");
      requireSecret(archiveMacKey, "ARCHIVE_MAC_KEY");
      const plan = readPlan(flags.plan!);
      const manifest = backupArchive(plan, flags["backup-dir"]!, archiveMacKey, {
        legacyArchiveMacKey,
        paymentReplayKey,
      });
      writeJsonExclusive(flags.out!, manifest);
      console.log(`backup: ${manifest.backupPath}\nmanifest: ${resolve(flags.out!)}\nmanifestDigest: ${manifest.manifestDigest}\nfiles: ${manifest.files}`);
      break;
    }
    case "apply": {
      requireValue(flags.plan, "--plan");
      requireValue(flags["backup-manifest"], "--backup-manifest");
      requireValue(flags.confirm, "--confirm");
      requireSecret(archiveMacKey, "ARCHIVE_MAC_KEY");
      const result = applyArchiveMigration(
        readPlan(flags.plan!),
        readBackupManifest(flags["backup-manifest"]!),
        archiveMacKey,
        flags.confirm!,
      );
      console.log([
        `changed: ${result.changed}`,
        `alreadyApplied: ${result.alreadyApplied}`,
        `legacyMoved: ${result.legacyMoved}`,
        `legacyAlreadyMoved: ${result.legacyAlreadyMoved}`,
        `quarantineMoved: ${result.quarantineMoved}`,
        `quarantineAlreadyMoved: ${result.quarantineAlreadyMoved}`,
        ...(result.coldManifest
          ? [
              `coldArchive: ${result.coldManifest.coldArchivePath}`,
              `coldManifestDigest: ${result.coldManifest.manifestDigest}`,
            ]
          : []),
      ].join("\n"));
      break;
    }
    case "apply-verify": {
      requireValue(flags.plan, "--plan");
      requireValue(flags["backup-manifest"], "--backup-manifest");
      requireValue(flags.confirm, "--confirm");
      requireSecret(archiveMacKey, "ARCHIVE_MAC_KEY");
      requireSecret(paymentReplayKey, "PAYMENT_REPLAY_KEY");
      const result = applyAndVerifyArchiveMigration(
        readPlan(flags.plan!),
        readBackupManifest(flags["backup-manifest"]!),
        {
          archiveDir,
          archiveMacKey,
          legacyArchiveMacKey,
          paymentReplayKey,
          pinnedSigningKey,
        },
        flags.confirm!,
      );
      console.log([
        `changed: ${result.apply.changed}`,
        `alreadyApplied: ${result.apply.alreadyApplied}`,
        `legacyMoved: ${result.apply.legacyMoved}`,
        `legacyAlreadyMoved: ${result.apply.legacyAlreadyMoved}`,
        `quarantineMoved: ${result.apply.quarantineMoved}`,
        `quarantineAlreadyMoved: ${result.apply.quarantineAlreadyMoved}`,
        ...(result.apply.coldManifest
          ? [
              `coldArchive: ${result.apply.coldManifest.coldArchivePath}`,
              `coldManifestDigest: ${result.apply.coldManifest.manifestDigest}`,
            ]
          : []),
        "strictReady: true",
        `archive: ${result.verification.archivePath}`,
        `records: ${result.verification.counts.records}`,
        `legacyRecords: ${result.verification.counts.legacyRecords}`,
        `claims: ${result.verification.counts.claims}`,
        `replayStates: ${result.verification.counts.replayStates}`,
      ].join("\n"));
      break;
    }
    case "verify": {
      requireSecret(archiveMacKey, "ARCHIVE_MAC_KEY");
      requireSecret(paymentReplayKey, "PAYMENT_REPLAY_KEY");
      const plan = flags.plan ? readPlan(flags.plan) : undefined;
      const result = verifyStrictArchive(
        { archiveDir, archiveMacKey, legacyArchiveMacKey, paymentReplayKey, pinnedSigningKey },
        plan,
      );
      console.log(`strictReady: true\narchive: ${result.archivePath}\nrecords: ${result.counts.records}\nlegacyRecords: ${result.counts.legacyRecords}\nclaims: ${result.counts.claims}\nreplayStates: ${result.counts.replayStates}`);
      break;
    }
    default:
      usage(`unknown command: ${command}`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

type Flags = Record<string, string | string[] | undefined>;

function parseFlags(input: string[], command: string): Flags {
  const parsed: Flags = {};
  const repeatable = new Set(["approve", "quarantine"]);
  const allowed = commandFlags(command);
  for (let i = 0; i < input.length; i++) {
    const item = input[i]!;
    if (!item.startsWith("--")) usage(`unexpected argument: ${item}`);
    const name = item.slice(2);
    if (allowed && !allowed.has(name)) usage(`unknown option for ${command}: --${name}`);
    const value = input[++i];
    if (!value || value.startsWith("--")) usage(`missing value for --${name}`);
    const current = parsed[name];
    if (current !== undefined && !repeatable.has(name)) {
      usage(`duplicate option: --${name}`);
    }
    parsed[name] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return parsed;
}

function commandFlags(command: string): Set<string> | undefined {
  const flags: Record<string, string[]> = {
    audit: ["archive", "out", "approval", "approval-review-out", "cold-archive-dir", "quarantine", "signing-public-key"],
    approve: ["archive", "approve", "out"],
    "approve-review": ["archive", "review", "reason", "out"],
    backup: ["plan", "backup-dir", "out"],
    apply: ["plan", "backup-manifest", "confirm"],
    "apply-verify": ["plan", "backup-manifest", "confirm", "signing-public-key"],
    verify: ["archive", "plan", "signing-public-key"],
  };
  const names = flags[command];
  return names ? new Set(names) : undefined;
}

function secret(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() || undefined;
}

function rejectArchiveOutputPaths(command: string, flags: Flags, archive: string): void {
  const roots = [canonicalPotentialPath(archive)];
  if (command === "audit" && typeof flags["cold-archive-dir"] === "string") {
    roots.push(canonicalPotentialPath(flags["cold-archive-dir"] as string));
  }
  if (command === "backup" && typeof flags["backup-dir"] === "string") {
    roots.push(canonicalPotentialPath(flags["backup-dir"] as string));
  }
  const outputs = [
    ...(command === "audit" ? [flags.out, flags["approval-review-out"]] : []),
    ...(command === "approve" || command === "approve-review" ? [flags.out] : []),
    ...(command === "backup" ? [flags.out] : []),
  ];
  for (const value of outputs) {
    if (typeof value !== "string") continue;
    const target = canonicalPotentialPath(value);
    if (roots.some((root) => inside(target, root))) {
      throw new Error("migration artifact outputs must be outside all protected archive, cold-archive, and backup roots");
    }
  }
}

/** Resolve a path through any existing symlinked ancestor before comparing it
 * with an archive/output root. This closes the common `alias/archive` bypass
 * where lexical `resolve()` sees a different path but the write follows a
 * symlink into the active archive. */
function canonicalPotentialPath(path: string): string {
  const candidate = resolve(path);
  let existing = candidate;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`path has no existing ancestor: ${candidate}`);
    suffix.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function inside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== "..");
}

function values(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function parseApproval(value: string): { path: string; sha256: string; reason: string } {
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first < 1 || second < first + 2) throw new Error(`invalid approval value: ${value}`);
  return { path: value.slice(0, first), sha256: value.slice(first + 1, second), reason: value.slice(second + 1) };
}

function parseQuarantine(value: string): QuarantineSelector {
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first < 1 || second < first + 2) throw new Error(`invalid quarantine value: ${value}`);
  return {
    path: value.slice(0, first),
    sha256: value.slice(first + 1, second),
    reason: value.slice(second + 1),
  };
}

function requireValue(value: string | string[] | undefined, name: string): asserts value is string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
}

function requireSecret(value: string | undefined, name: string): asserts value is string {
  if (!value) throw new Error(`${name} must be supplied through the environment or a protected environment file`);
}

function printPlan(plan: ReturnType<typeof auditArchive>, out: string | string[] | undefined): void {
  console.log([
    `archive: ${plan.archivePath}`,
    `plan: ${typeof out === "string" ? resolve(out) : "not written (use --out)"}`,
    `planDigest: ${plan.planDigest}`,
    `inventoryDigest: ${plan.inventoryDigest}`,
    `files: ${plan.counts.files}`,
    `records: ${plan.counts.records}`,
    `legacyRecords: ${plan.counts.legacyRecords}`,
    `approvedLegacyRecords: ${plan.counts.approvedLegacyRecords}`,
    `approvedQuarantineRecords: ${plan.counts.approvedQuarantineRecords}`,
    `nonCanonicalTransactions: ${plan.counts.nonCanonicalTransactions}`,
    `coldArchive: ${plan.coldArchivePath ?? "not planned"}`,
    `claims: ${plan.counts.claims}`,
    `replayStates: ${plan.counts.replayStates}`,
    `replayHolds: ${plan.counts.replayHolds}`,
    `changes: ${plan.counts.changes}`,
    `quarantineDispositions: ${plan.counts.quarantineDispositions}`,
    `errors: ${plan.counts.errors}`,
    `warnings: ${plan.counts.warnings}`,
  ].join("\n"));
  for (const item of plan.findings.slice(0, 50)) {
    console.log(`${item.severity.toUpperCase()} ${item.code}${item.path ? ` ${item.path}` : ""}: ${item.message}`);
  }
  if (plan.findings.length > 50) console.log(`... ${plan.findings.length - 50} more finding(s) are in the plan`);
}

function usage(message: string): never {
  throw new Error(`${message}\nusage:\n  node --import tsx scripts/archive-migrate.ts audit [--archive DIR] --out PLAN [--approval FILE] [--approval-review-out FILE] [--cold-archive-dir DIR] [--quarantine path:sha256:reason] [--signing-public-key KEY]\n  node --import tsx scripts/archive-migrate.ts approve [--archive DIR] --approve path:sha256:reason --out APPROVAL\n  node --import tsx scripts/archive-migrate.ts approve-review [--archive DIR] --review FILE --reason TEXT --out APPROVAL\n  node --import tsx scripts/archive-migrate.ts backup --plan PLAN --backup-dir DIR --out MANIFEST\n  node --import tsx scripts/archive-migrate.ts apply --plan PLAN --backup-manifest MANIFEST --confirm PLAN_DIGEST\n  node --import tsx scripts/archive-migrate.ts apply-verify --plan PLAN --backup-manifest MANIFEST --confirm PLAN_DIGEST [--signing-public-key KEY]\n  node --import tsx scripts/archive-migrate.ts verify [--archive DIR] [--plan PLAN]`);
}
