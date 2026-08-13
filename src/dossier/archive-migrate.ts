import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  copyFileSync,
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256, type Attestation, verifyAttestation } from "../attest";
import {
  type ArchiveRecord,
  type ConfirmedSettlement,
  type TransactionClaim,
  LOWER_SHA256_PATTERN,
  RECORD_ID_PATTERN,
  SHA256_PATTERN,
  archiveKeyFingerprint,
  archiveRecordDigest,
  archiveRecordMac,
  archiveRecordMacValid,
  canonicalValue,
  legacyArchiveRecordMacValid,
  mergedClaimRecord,
  settlementSame,
  transactionClaimMac,
  transactionClaimShapeValid,
  transactionClaimValid,
  transactionKey,
  validConfirmedSettlement,
  validTransactionHash,
} from "./archive-format";

export const ARCHIVE_MIGRATION_PLAN_VERSION = "dossier-archive-migration-plan/1";
export const ARCHIVE_BACKUP_MANIFEST_VERSION = "dossier-archive-backup-manifest/1";
export const ARCHIVE_APPROVAL_VERSION = "dossier-archive-approval/1";
export const ARCHIVE_COLD_MANIFEST_VERSION = "dossier-archive-cold-manifest/1";
export const ARCHIVE_APPROVAL_REVIEW_VERSION = "dossier-archive-approval-review/1";

const PLAN_MAC_CONTEXT = "dossier-archive-migration-plan:";
const MANIFEST_MAC_CONTEXT = "dossier-archive-backup-manifest:";
const APPROVAL_MAC_CONTEXT = "dossier-archive-approval:";
const COLD_MANIFEST_MAC_CONTEXT = "dossier-archive-cold-manifest:";
const MIGRATION_LOCK_NAME = ".archive-migration.lock";
const ARCHIVE_LOCK_NAME = ".archive.lock";
const COLD_MANIFEST_NAME = ".dossier-cold-archive-manifest.json";

export type MigrationSeverity = "error" | "warning" | "info";

export interface MigrationFinding {
  severity: MigrationSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface MigrationInventoryEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "special";
  mode: number;
  size: number;
  sha256?: string;
  target?: string;
}

export interface MigrationChange {
  path: string;
  kind: "claim" | "record";
  inputSha256: string;
  outputSha256: string;
  outputBase64: string;
  approvalRequired: boolean;
  evidence: "current-mac" | "signed-json" | "operator-approval";
}

export interface LegacyDisposition {
  path: string;
  inputSha256: string;
  approvalRequired: true;
  evidence: "operator-approval" | "unapproved";
}

export interface ArchiveMigrationPlan {
  version: typeof ARCHIVE_MIGRATION_PLAN_VERSION;
  archivePath: string;
  createdAt: string;
  inventory: MigrationInventoryEntry[];
  inventoryDigest: string;
  archiveKeyFingerprint: string | null;
  legacyArchiveKeyFingerprint: string | null;
  replayKeyFingerprint: string | null;
  pinnedSigningKey: string | null;
  approvalDigest: string | null;
  approvalReviewDigest: string | null;
  coldArchivePath: string | null;
  counts: {
    files: number;
    records: number;
    legacyRecords: number;
    claims: number;
    replayStates: number;
    replayHolds: number;
    unsignedRecords: number;
    unsignedClaims: number;
    approvedRecords: number;
    approvedLegacyRecords: number;
    nonCanonicalTransactions: number;
    changes: number;
    legacyDispositions: number;
    errors: number;
    warnings: number;
  };
  findings: MigrationFinding[];
  changes: MigrationChange[];
  legacyDispositions: LegacyDisposition[];
  planDigest: string;
  planMac: string | null;
}

export interface ArchiveApproval {
  version: typeof ARCHIVE_APPROVAL_VERSION;
  archivePath: string;
  inventoryDigest: string;
  planDigest: string | null;
  coldArchivePath: string | null;
  approvedFiles: Array<{ path: string; sha256: string; reason: string }>;
  approvalDigest: string;
  approvalMac: string;
}

export interface ArchiveBackupManifest {
  version: typeof ARCHIVE_BACKUP_MANIFEST_VERSION;
  archivePath: string;
  backupPath: string;
  createdAt: string;
  planDigest: string;
  sourceInventoryDigest: string;
  backupInventoryDigest: string;
  files: number;
  manifestDigest: string;
  manifestMac: string;
}

export interface ArchiveColdManifest {
  version: typeof ARCHIVE_COLD_MANIFEST_VERSION;
  archivePath: string;
  coldArchivePath: string;
  createdAt: string;
  planDigest: string;
  sourceInventoryDigest: string;
  status: "prepared" | "complete";
  files: Array<{ path: string; sha256: string }>;
  filesDigest: string;
  manifestDigest: string;
  manifestMac: string;
}

export interface ArchiveApprovalReview {
  version: typeof ARCHIVE_APPROVAL_REVIEW_VERSION;
  archivePath: string;
  reviewDigest: string;
  inventoryDigest: string;
  coldArchivePath: string | null;
  files: Array<{
    path: string;
    sha256: string;
    actions: Array<
      | "authenticate-record"
      | "authenticate-claim"
      | "move-legacy-to-cold-archive"
    >;
  }>;
}

export interface AuditOptions {
  archiveDir: string;
  archiveMacKey?: string;
  legacyArchiveMacKey?: string;
  paymentReplayKey?: string;
  pinnedSigningKey?: string;
  approval?: ArchiveApproval;
  coldArchiveDir?: string;
  now?: Date;
  ignoreOwnedMigrationLocks?: boolean;
}

export type ApprovalReviewAuditOptions = Pick<
  AuditOptions,
  "legacyArchiveMacKey" | "paymentReplayKey" | "pinnedSigningKey"
>;

export type BackupAuditOptions = Pick<AuditOptions, "legacyArchiveMacKey" | "paymentReplayKey">;

interface ParsedRecord {
  name: string;
  bytes: Buffer;
  sha256: string;
  record: ArchiveRecord;
  currentMac: boolean;
  evidence: MigrationChange["evidence"] | null;
}

interface ParsedClaim {
  name: string;
  bytes: Buffer;
  sha256: string;
  claim: TransactionClaim;
  currentMac: boolean;
}

interface ReplayState {
  v: 1;
  fingerprint: string;
  status: "pending" | "unknown" | "confirmed";
  attemptToken: string;
  request: { paramsSha256: string; contentType: "text/html" | "application/json" | "invalid" };
  requirements: { scheme: string; network: string; amount: string; asset: string; payTo: string };
  createdAt: string;
  updatedAt: string;
  ownerPid?: number;
  ownerStartedAt?: number;
  ownerToken?: string;
  reportId?: string;
  reason?: string;
  settlement?: Omit<ConfirmedSettlement, "status">;
  settlementEvidence?: "candidate" | "confirmed";
  mac: string;
}

interface ReplayHold {
  v: 1;
  reportId: string;
  fingerprint: string;
  attemptToken: string;
  mac: string;
}

interface ScanResult {
  inventory: MigrationInventoryEntry[];
  digest: string;
}

export function auditArchive(options: AuditOptions): ArchiveMigrationPlan {
  const archivePath = realExistingDirectory(options.archiveDir);
  const first = scanInventory(archivePath);
  const findings: MigrationFinding[] = [];
  const archiveDirectoryMode = statSync(archivePath).mode & 0o777;
  if ((archiveDirectoryMode & 0o077) !== 0) {
    finding(
      findings,
      "error",
      "archive_root_permissions",
      "archive directory must not be group- or world-accessible",
      ".",
    );
  }
  const records = new Map<string, ParsedRecord>();
  const claims: ParsedClaim[] = [];
  const states = new Map<string, { name: string; state: ReplayState }>();
  const holds: Array<{ name: string; hold: ReplayHold }> = [];
  const approved = validateApproval(options.approval, archivePath, first.digest, options.archiveMacKey);
  const changes: MigrationChange[] = [];
  const legacyDispositions: LegacyDisposition[] = [];
  const reported = new Set<string>();
  let legacyRecords = 0;
  let unsignedRecords = 0;
  let unsignedClaims = 0;
  let approvedRecords = 0;
  let approvedLegacyRecords = 0;
  let nonCanonicalTransactions = 0;
  const coldArchivePath = options.coldArchiveDir
    ? separateExternalDirectory(options.coldArchiveDir, archivePath, "cold archive")
    : null;
  const coldDispositionApproval = Boolean(
    coldArchivePath &&
    options.approval?.planDigest &&
    options.approval.coldArchivePath === coldArchivePath
  );

  for (const entry of first.inventory) {
    if (options.ignoreOwnedMigrationLocks && ownedMigrationEntry(archivePath, entry.path)) {
      continue;
    }
    if (entry.kind !== "file") {
      finding(
        findings,
        "error",
        entry.kind === "symlink" ? "symlink" : "special_entry",
        `${entry.kind} entries are not allowed in an archive migration`,
        entry.path,
      );
      continue;
    }
    if ((entry.mode & 0o077) !== 0) {
      finding(
        findings,
        "error",
        "archive_permissions",
        "archive files must not be group- or world-accessible",
        entry.path,
      );
    }
    const path = join(archivePath, entry.path);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== entry.sha256) {
      finding(findings, "error", "unstable_file", "file changed while it was being read", entry.path);
      continue;
    }

    if (isRecordName(entry.path)) {
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        finding(findings, "error", "malformed_record", "record is not valid JSON", entry.path);
        continue;
      }
      const legacy = isLegacyRecord(value, entry.path);
      if (legacy) {
        legacyRecords++;
        const dispositionApproved = Boolean(
          coldDispositionApproval && entry.sha256 && approved.has(`${entry.path}\0${entry.sha256}`),
        );
        if (dispositionApproved) approvedLegacyRecords++;
        legacyDispositions.push({
          path: entry.path,
          inputSha256: entry.sha256!,
          approvalRequired: true,
          evidence: dispositionApproved ? "operator-approval" : "unapproved",
        });
        finding(
          findings,
          coldArchivePath
            ? dispositionApproved
              ? "info"
              : "error"
            : "error",
          coldArchivePath
            ? dispositionApproved
              ? "legacy_v1_cold_archive_planned"
              : "legacy_v1_cold_archive_unapproved"
            : "legacy_v1_cold_archive_required",
          coldArchivePath
            ? dispositionApproved
              ? "legacy request-keyed record will be copied to the authenticated cold archive and removed from the active archive only after checksum verification"
              : "legacy request-keyed record needs plan-bound approve-review authorization before cold-archive disposition"
            : "legacy request-keyed record requires an external cold archive before migration can continue",
          entry.path,
        );
        continue;
      }
      const error = recordShapeError(value, entry.path);
      if (error) {
        finding(findings, "error", "invalid_record", error, entry.path);
        continue;
      }
      const record = value as ArchiveRecord;
      const currentMac = Boolean(
        record.mac && archiveRecordMacValid(record, options.archiveMacKey, true),
      );
      const legacyMac = Boolean(
        record.mac && legacyArchiveRecordMacValid(record, options.legacyArchiveMacKey),
      );
      if (record.mac && !currentMac && !legacyMac) {
        finding(
          findings,
          "error",
          "record_mac_invalid",
          "record MAC does not verify with the current or explicitly supplied legacy key",
          entry.path,
        );
      }
      const exactApproval = Boolean(
        entry.sha256 && approved.has(`${entry.path}\0${entry.sha256}`),
      );
      // The legacy MAC authenticates report bytes and several identifiers, but
      // it never covered `request` or `settlement`. Treat it as useful
      // historical evidence only: stamping a current MAC over those fields
      // requires approval of the exact record bytes.
      let evidence: MigrationChange["evidence"] | null = currentMac
        ? "current-mac"
        : exactApproval
          ? "operator-approval"
          : null;
      if (legacyMac && !currentMac) {
        finding(
          findings,
          "info",
          "legacy_record_mac_partial",
          "legacy MAC verifies only the fields covered by the historical format; exact-file approval is still required for request and settlement metadata",
          entry.path,
        );
      }
      const signedJson = signedJsonEvidence(record, options.pinnedSigningKey);
      if (!evidence && signedJson) {
        finding(
          findings,
          "info",
          "signed_json_content_verified",
          "pinned attestation verifies the report bytes, but archive identity/payment fields still require hash-bound approval",
          entry.path,
        );
      }
      if (exactApproval && !currentMac) {
        approvedRecords++;
      }
      if (!record.mac) unsignedRecords++;
      const parsed: ParsedRecord = {
        name: entry.path,
        bytes,
        sha256: entry.sha256!,
        record,
        currentMac,
        evidence,
      };
      if (records.has(record.id)) {
        finding(findings, "error", "duplicate_record_id", "record id appears more than once", entry.path);
      } else {
        records.set(record.id, parsed);
      }
      if (!currentMac) {
        if (!options.archiveMacKey) {
          findingOnce(findings, reported, "error", "archive_key_missing", "ARCHIVE_MAC_KEY is required to plan backfill");
        } else if (!evidence) {
          finding(
            findings,
            "error",
            "record_unapproved",
            signedJson
              ? "signed report bytes lack hash-bound approval for archive identity and payment metadata"
              : "unsigned or legacy-MAC record lacks hash-bound approval",
            entry.path,
          );
        } else {
          const stamped = { ...record, mac: archiveRecordMac(record, options.archiveMacKey)! };
          const output = Buffer.from(JSON.stringify(stamped));
          changes.push({
            path: entry.path,
            kind: "record",
            inputSha256: entry.sha256!,
            outputSha256: sha256(output),
            outputBase64: output.toString("base64"),
            approvalRequired: evidence === "operator-approval",
            evidence,
          });
        }
      }
      continue;
    }

    if (isClaimName(entry.path)) {
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        finding(findings, "error", "malformed_claim", "claim is not valid JSON", entry.path);
        continue;
      }
      if (!transactionClaimShapeValid(value)) {
        finding(findings, "error", "invalid_claim", "claim shape is invalid", entry.path);
        continue;
      }
      const expectedName = `.tx-${transactionKey(value.transaction)}.claim`;
      if (entry.path !== expectedName) {
        finding(findings, "error", "claim_filename_mismatch", "claim filename does not match its transaction", entry.path);
      }
      const currentMac = Boolean(
        value.mac && transactionClaimValid(value, options.archiveMacKey, true),
      );
      if (value.mac && !currentMac) {
        finding(findings, "error", "claim_mac_invalid", "claim MAC does not verify", entry.path);
      }
      if (!value.mac) unsignedClaims++;
      claims.push({ name: entry.path, bytes, sha256: entry.sha256!, claim: value, currentMac });
      continue;
    }

    if (isReplayStateName(entry.path)) {
      const fingerprint = entry.path.slice(".payment-".length, -".state".length);
      const state = parseReplayState(bytes, fingerprint, options.paymentReplayKey);
      if (!state) {
        if (!options.paymentReplayKey) {
          findingOnce(findings, reported, "error", "replay_key_missing", "PAYMENT_REPLAY_KEY is required to validate replay state");
        } else {
          finding(findings, "error", "invalid_replay_state", "replay state is malformed or fails its MAC", entry.path);
        }
      } else {
        states.set(fingerprint, { name: entry.path, state });
      }
      continue;
    }

    if (isReplayHoldName(entry.path)) {
      const hold = parseReplayHold(bytes, options.paymentReplayKey);
      if (!hold) {
        if (!options.paymentReplayKey) {
          findingOnce(findings, reported, "error", "replay_key_missing", "PAYMENT_REPLAY_KEY is required to validate replay state");
        } else {
          finding(findings, "error", "invalid_replay_hold", "replay hold is malformed or fails its MAC", entry.path);
        }
      } else {
        holds.push({ name: entry.path, hold });
      }
      continue;
    }

    finding(findings, "error", "unknown_file", "unrecognized file in archive", entry.path);
  }

  const transactionOwners = new Map<string, string>();
  for (const parsed of records.values()) {
    const transaction = parsed.record.settlement?.transaction || parsed.record.paymentTransaction;
    if (!transaction) continue;
    if (!validTransactionHash(transaction)) {
      nonCanonicalTransactions++;
      finding(
        findings,
        "info",
        "historical_transaction_metadata",
        "non-canonical transaction value is preserved inside the authenticated record but is not trusted as a current payment claim",
        parsed.name,
      );
      continue;
    }
    const normalized = transaction.toLowerCase();
    const owner = transactionOwners.get(normalized);
    if (owner && owner !== parsed.record.id) {
      finding(
        findings,
        "error",
        "ambiguous_transaction",
        `transaction has multiple record owners (${owner}, ${parsed.record.id})`,
        parsed.name,
      );
    } else {
      transactionOwners.set(normalized, parsed.record.id);
    }
  }

  for (const parsed of claims) {
    if (parsed.claim.mac && !parsed.currentMac) {
      // Never replace an existing, invalid authenticator. Re-signing the same
      // payload with the current key would turn corrupted or foreign-key claim
      // bytes into trusted ownership metadata.
      continue;
    }
    const owner = records.get(parsed.claim.recordId);
    if (!owner || !mergedClaimRecord(owner.record, parsed.claim)) {
      finding(findings, "error", "claim_owner_mismatch", "claim owner or record digest does not match", parsed.name);
      continue;
    }
    const normalized = parsed.claim.transaction.toLowerCase();
    const existing = transactionOwners.get(normalized);
    if (existing && existing !== parsed.claim.recordId) {
      finding(findings, "error", "ambiguous_claim", "claim conflicts with another transaction owner", parsed.name);
      continue;
    }
    transactionOwners.set(normalized, parsed.claim.recordId);
    if (!parsed.currentMac && !parsed.claim.mac) {
      if (!options.archiveMacKey) {
        findingOnce(findings, reported, "error", "archive_key_missing", "ARCHIVE_MAC_KEY is required to plan backfill");
      } else {
        const metadataMatches = claimMetadataMatchesRecord(owner.record, parsed.claim);
        const recordMetadataTrusted =
          owner.currentMac || owner.evidence === "operator-approval";
        const claimApproved = approved.has(`${parsed.name}\0${parsed.sha256}`);
        if (!(metadataMatches && recordMetadataTrusted) && !claimApproved) {
          finding(
            findings,
            "error",
            "claim_unapproved",
            metadataMatches
              ? "unsigned claim matches record metadata that is not authenticated; approve the exact claim or record bytes before signing it"
              : "unsigned claim adds transaction or settlement metadata not present in the authenticated record; approve the exact claim bytes before signing it",
            parsed.name,
          );
          continue;
        }
        const { mac: _mac, ...unsigned } = parsed.claim;
        const output = Buffer.from(
          JSON.stringify({ ...unsigned, mac: transactionClaimMac(unsigned, options.archiveMacKey)! }),
        );
        const claimApprovalRequired = !(metadataMatches && recordMetadataTrusted);
        changes.push({
          path: parsed.name,
          kind: "claim",
          inputSha256: parsed.sha256,
          outputSha256: sha256(output),
          outputBase64: output.toString("base64"),
          approvalRequired: claimApprovalRequired,
          evidence: claimApprovalRequired
            ? "operator-approval"
            : owner.evidence ?? "operator-approval",
        });
      }
    }
  }

  validateReplayLinks(findings, records, transactionOwners, states, holds);

  const second = scanInventory(archivePath);
  const effectiveFirst = options.ignoreOwnedMigrationLocks
    ? filteredInventory(first.inventory, archivePath)
    : first.inventory;
  const effectiveSecond = options.ignoreOwnedMigrationLocks
    ? filteredInventory(second.inventory, archivePath)
    : second.inventory;
  const effectiveDigest = digestObject(effectiveFirst);
  if (effectiveDigest !== digestObject(effectiveSecond)) {
    finding(findings, "error", "unstable_inventory", "archive changed between the two read-only scans");
  }

  changes.sort((a, b) => {
    const kind = a.kind === b.kind ? 0 : a.kind === "claim" ? -1 : 1;
    return kind || a.path.localeCompare(b.path);
  });
  findings.sort((a, b) =>
    `${a.severity}:${a.code}:${a.path ?? ""}`.localeCompare(
      `${b.severity}:${b.code}:${b.path ?? ""}`,
    ),
  );
  const withoutDigest = {
    version: ARCHIVE_MIGRATION_PLAN_VERSION,
    archivePath,
    createdAt: (options.now ?? new Date()).toISOString(),
    inventory: effectiveFirst,
    inventoryDigest: effectiveDigest,
    archiveKeyFingerprint: archiveKeyFingerprint(options.archiveMacKey),
    legacyArchiveKeyFingerprint: archiveKeyFingerprint(options.legacyArchiveMacKey),
    replayKeyFingerprint: replayKeyFingerprint(options.paymentReplayKey),
    pinnedSigningKey: options.pinnedSigningKey ?? null,
    approvalDigest: options.approval?.approvalDigest ?? null,
    approvalReviewDigest: options.approval?.planDigest ?? null,
    coldArchivePath,
    counts: {
      files: effectiveFirst.filter((entry) => entry.kind === "file").length,
      records: records.size,
      legacyRecords,
      claims: claims.length,
      replayStates: states.size,
      replayHolds: holds.length,
      unsignedRecords,
      unsignedClaims,
      approvedRecords,
      approvedLegacyRecords,
      nonCanonicalTransactions,
      changes: changes.length,
      legacyDispositions: legacyDispositions.length,
      errors: findings.filter((item) => item.severity === "error").length,
      warnings: findings.filter((item) => item.severity === "warning").length,
    },
    findings,
    changes,
    legacyDispositions,
  } satisfies Omit<ArchiveMigrationPlan, "planDigest" | "planMac">;
  const planDigest = digestObject(withoutDigest);
  if (options.approval?.planDigest) {
    if (
      options.approval.planDigest !== migrationReviewDigest(withoutDigest) ||
      options.approval.coldArchivePath !== coldArchivePath
    ) {
      throw new Error("approval is bound to a different migration plan or cold archive");
    }
  }
  return {
    ...withoutDigest,
    planDigest,
    planMac: keyedDigest(PLAN_MAC_CONTEXT, planDigest, options.archiveMacKey),
  };
}

export function verifyPlan(plan: ArchiveMigrationPlan, archiveMacKey?: string): void {
  assertMigrationPlanShape(plan);
  if (plan.version !== ARCHIVE_MIGRATION_PLAN_VERSION) throw new Error("unsupported plan version");
  const { planDigest, planMac, ...unsigned } = plan;
  if (digestObject(unsigned) !== planDigest) throw new Error("plan digest does not match its contents");
  const expectedFingerprint = archiveKeyFingerprint(archiveMacKey);
  if (expectedFingerprint !== plan.archiveKeyFingerprint) throw new Error("plan archive key fingerprint mismatch");
  const expectedMac = keyedDigest(PLAN_MAC_CONTEXT, planDigest, archiveMacKey);
  if (!planMac || !expectedMac || !safeEqual(planMac, expectedMac)) {
    throw new Error("plan authentication failed");
  }
}

export function createArchiveApproval(
  archiveDir: string,
  approvedFiles: Array<{ path: string; sha256: string; reason: string }>,
  archiveMacKey: string,
): ArchiveApproval {
  const archivePath = realExistingDirectory(archiveDir);
  const inventory = scanInventory(archivePath);
  const files = approvedFiles
    .map((item) => ({ path: safeRelativePath(item.path), sha256: item.sha256, reason: item.reason.trim() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.some((item) => !SHA256_PATTERN.test(item.sha256) || !item.reason)) {
    throw new Error("every approval needs an exact SHA-256 and non-empty reason");
  }
  for (const item of files) {
    const found = inventory.inventory.find((entry) => entry.path === item.path && entry.kind === "file");
    if (!found || found.sha256 !== item.sha256) throw new Error(`approval does not match archive file: ${item.path}`);
  }
  const unsigned = {
    version: ARCHIVE_APPROVAL_VERSION,
    archivePath,
    inventoryDigest: inventory.digest,
    planDigest: null,
    coldArchivePath: null,
    approvedFiles: files,
  } as const;
  const approvalDigest = digestObject(unsigned);
  return {
    ...unsigned,
    approvalDigest,
    approvalMac: keyedDigest(APPROVAL_MAC_CONTEXT, approvalDigest, archiveMacKey)!,
  };
}

export function createArchiveApprovalReview(
  plan: ArchiveMigrationPlan,
): ArchiveApprovalReview {
  return {
    version: ARCHIVE_APPROVAL_REVIEW_VERSION,
    archivePath: plan.archivePath,
    reviewDigest: migrationReviewDigest(plan),
    inventoryDigest: plan.inventoryDigest,
    coldArchivePath: plan.coldArchivePath,
    files: createReviewFiles(plan),
  };
}

export function createArchiveApprovalFromReview(
  archiveDir: string,
  review: ArchiveApprovalReview,
  reason: string,
  archiveMacKey: string,
  auditOptions: ApprovalReviewAuditOptions = {},
): ArchiveApproval {
  assertApprovalReviewShape(review);
  if (review.version !== ARCHIVE_APPROVAL_REVIEW_VERSION) {
    throw new Error("unsupported approval review version");
  }
  const archivePath = realExistingDirectory(archiveDir);
  if (review.archivePath !== archivePath) throw new Error("approval review names a different archive");
  if (!reason.trim()) throw new Error("approval reason is required");
  const inventory = scanInventory(archivePath);
  if (review.inventoryDigest !== inventory.digest) {
    throw new Error("approval review is bound to a different archive snapshot");
  }
  const requestedColdArchive = review.coldArchivePath ?? undefined;
  const unsignedPlan = auditArchive({
    archiveDir: archivePath,
    archiveMacKey,
    ...auditOptions,
    coldArchiveDir: requestedColdArchive,
  });
  const freshReview = createArchiveApprovalReview(unsignedPlan);
  if (review.reviewDigest !== migrationReviewDigest(unsignedPlan)) {
    throw new Error("approval review plan digest no longer matches the archive");
  }
  if (canonicalValue(review.files) !== canonicalValue(freshReview.files)) {
    throw new Error("approval review file set or actions were altered");
  }
  const base = createArchiveApproval(
    archivePath,
    review.files.map((item) => ({ path: item.path, sha256: item.sha256, reason: reason.trim() })),
    archiveMacKey,
  );
  const unsigned = {
    version: ARCHIVE_APPROVAL_VERSION,
    archivePath: base.archivePath,
    inventoryDigest: base.inventoryDigest,
    planDigest: review.reviewDigest,
    coldArchivePath: requestedColdArchive ?? null,
    approvedFiles: base.approvedFiles,
  } as const;
  const approvalDigest = digestObject(unsigned);
  return {
    ...unsigned,
    approvalDigest,
    approvalMac: keyedDigest(APPROVAL_MAC_CONTEXT, approvalDigest, archiveMacKey)!,
  };
}

export function backupArchive(
  plan: ArchiveMigrationPlan,
  backupDir: string,
  archiveMacKey: string,
  auditOptions: BackupAuditOptions = {},
): ArchiveBackupManifest {
  verifyPlan(plan, archiveMacKey);
  if (archiveKeyFingerprint(auditOptions.legacyArchiveMacKey) !== plan.legacyArchiveKeyFingerprint) {
    throw new Error("backup legacy archive key fingerprint differs from plan");
  }
  if (replayKeyFingerprint(auditOptions.paymentReplayKey) !== plan.replayKeyFingerprint) {
    throw new Error("backup replay key fingerprint differs from plan");
  }
  requireCleanPlan(plan);
  const archivePath = realExistingDirectory(plan.archivePath);
  assertOffline(archivePath);
  return withMigrationOwnership(archivePath, () => {
    assertNoLiveServiceLease(archivePath);
    const current = scanInventory(archivePath);
    const filtered = filteredInventory(current.inventory, archivePath);
    if (digestObject(filtered) !== plan.inventoryDigest) throw new Error("archive no longer matches the plan inventory");
    const backupPath = separateExternalDirectory(backupDir, archivePath, "backup");
    if (existsSync(backupPath)) throw new Error("backup destination already exists");
    mkdirSync(backupPath, { recursive: false, mode: 0o700 });
    if (realExistingDirectory(backupPath) !== backupPath) {
      throw new Error("backup destination changed while it was being created");
    }
    let complete = false;
    try {
    for (const entry of filtered) {
      if (entry.kind !== "file") throw new Error(`cannot back up non-file archive entry: ${entry.path}`);
      const source = join(archivePath, entry.path);
      const destination = join(backupPath, entry.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
      const fd = openSync(destination, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    syncTreeDirectories(backupPath);
    const backup = scanInventory(backupPath);
    if (backup.digest !== plan.inventoryDigest) throw new Error("backup checksum differs from source snapshot");
    const backupAudit = auditArchive({
      archiveDir: backupPath,
      archiveMacKey,
      ...auditOptions,
      pinnedSigningKey: plan.pinnedSigningKey ?? undefined,
    });
    const admissible = new Set(["record_unapproved", "legacy_v1_cold_archive_required"]);
    const semanticBlockers = backupAudit.findings.filter(
      (item) => item.severity === "error" && !admissible.has(item.code),
    );
    if (semanticBlockers.length) throw new Error(`backup semantic audit failed: ${semanticBlockers[0]!.code}`);
    const unsigned = {
      version: ARCHIVE_BACKUP_MANIFEST_VERSION,
      archivePath,
      backupPath,
      createdAt: new Date().toISOString(),
      planDigest: plan.planDigest,
      sourceInventoryDigest: plan.inventoryDigest,
      backupInventoryDigest: backup.digest,
      files: backup.inventory.filter((entry) => entry.kind === "file").length,
    } as const;
    const manifestDigest = digestObject(unsigned);
    complete = true;
    return {
      ...unsigned,
      manifestDigest,
      manifestMac: keyedDigest(MANIFEST_MAC_CONTEXT, manifestDigest, archiveMacKey)!,
    };
    } finally {
    if (!complete) {
      // A partial backup remains visible for forensic inspection. It never gets
      // a qualifying manifest and therefore cannot authorize apply.
      }
    }
  });
}

export function verifyBackupManifest(
  manifest: ArchiveBackupManifest,
  plan: ArchiveMigrationPlan,
  archiveMacKey: string,
): void {
  assertMigrationPlanShape(plan);
  assertBackupManifestShape(manifest);
  verifyPlan(plan, archiveMacKey);
  if (manifest.version !== ARCHIVE_BACKUP_MANIFEST_VERSION) throw new Error("unsupported backup manifest version");
  const { manifestDigest, manifestMac, ...unsigned } = manifest;
  if (digestObject(unsigned) !== manifestDigest) throw new Error("backup manifest digest mismatch");
  const expected = keyedDigest(MANIFEST_MAC_CONTEXT, manifestDigest, archiveMacKey);
  if (!expected || !safeEqual(expected, manifestMac)) throw new Error("backup manifest authentication failed");
  if (
    manifest.planDigest !== plan.planDigest ||
    manifest.archivePath !== plan.archivePath ||
    manifest.sourceInventoryDigest !== plan.inventoryDigest
  ) {
    throw new Error("backup manifest does not authorize this plan");
  }
  const backup = scanInventory(realExistingDirectory(manifest.backupPath));
  if (backup.digest !== manifest.backupInventoryDigest || backup.digest !== plan.inventoryDigest) {
    throw new Error("backup bytes no longer match the planned archive snapshot");
  }
}

export function applyArchiveMigration(
  plan: ArchiveMigrationPlan,
  manifest: ArchiveBackupManifest,
  archiveMacKey: string,
  confirmedPlanDigest: string,
): {
  changed: number;
  alreadyApplied: number;
  legacyMoved: number;
  legacyAlreadyMoved: number;
  coldManifest: ArchiveColdManifest | null;
} {
  validateApplyInputs(plan, manifest, archiveMacKey, confirmedPlanDigest);
  const archivePath = realExistingDirectory(plan.archivePath);
  assertOffline(archivePath);
  return withMigrationLocks(archivePath, () => {
    assertNoLiveServiceLease(archivePath);
    return applyArchiveMigrationOwned(plan, archiveMacKey, archivePath);
  });
}

export function applyAndVerifyArchiveMigration(
  plan: ArchiveMigrationPlan,
  manifest: ArchiveBackupManifest,
  options: AuditOptions & { archiveMacKey: string },
  confirmedPlanDigest: string,
): {
  apply: ReturnType<typeof applyArchiveMigrationOwned>;
  verification: ArchiveMigrationPlan;
} {
  validateApplyInputs(plan, manifest, options.archiveMacKey, confirmedPlanDigest);
  const archivePath = realExistingDirectory(plan.archivePath);
  assertOffline(archivePath);
  return withMigrationLocks(archivePath, () => {
    assertNoLiveServiceLease(archivePath);
    const apply = applyArchiveMigrationOwned(plan, options.archiveMacKey, archivePath);
    const verification = verifyStrictArchiveOwned(
      { ...options, archiveDir: archivePath },
      plan,
    );
    return { apply, verification };
  });
}

function validateApplyInputs(
  plan: ArchiveMigrationPlan,
  manifest: ArchiveBackupManifest,
  archiveMacKey: string,
  confirmedPlanDigest: string,
): void {
  verifyPlan(plan, archiveMacKey);
  requireCleanPlan(plan);
  verifyBackupManifest(manifest, plan, archiveMacKey);
  if (confirmedPlanDigest !== plan.planDigest) throw new Error("exact plan digest confirmation is required");
}

function applyArchiveMigrationOwned(
  plan: ArchiveMigrationPlan,
  archiveMacKey: string,
  archivePath: string,
): {
  changed: number;
  alreadyApplied: number;
  legacyMoved: number;
  legacyAlreadyMoved: number;
  coldManifest: ArchiveColdManifest | null;
} {
  const allowed = new Map(plan.inventory.map((entry) => [entry.path, entry]));
  const dispositions = new Map(plan.legacyDispositions.map((entry) => [entry.path, entry]));
  const current = { ...scanInventory(archivePath) };
  current.inventory = filteredInventory(current.inventory, archivePath);
  for (const entry of current.inventory) {
    const original = allowed.get(entry.path);
    const change = plan.changes.find((candidate) => candidate.path === entry.path);
    if (!original) throw new Error(`unexpected archive entry: ${entry.path}`);
    if (entry.kind !== "file" || original.kind !== "file") throw new Error(`unsafe archive entry: ${entry.path}`);
    if (entry.sha256 !== original.sha256 && entry.sha256 !== change?.outputSha256) {
      throw new Error(`archive file is neither planned input nor output: ${entry.path}`);
    }
  }
  for (const original of plan.inventory) {
    if (current.inventory.some((entry) => entry.path === original.path)) continue;
    if (!dispositions.has(original.path) || !coldDispositionPresent(plan, original.path, archiveMacKey)) {
      throw new Error(`archive inventory no longer matches the plan: ${original.path}`);
    }
  }
  let changed = 0;
  let alreadyApplied = 0;
  for (const change of plan.changes) {
    const path = join(archivePath, safeRelativePath(change.path));
    const currentHash = sha256(readFileSync(path));
    if (currentHash === change.outputSha256) {
      alreadyApplied++;
      continue;
    }
    if (currentHash !== change.inputSha256) throw new Error(`planned input changed: ${change.path}`);
    const output = Buffer.from(change.outputBase64, "base64");
    if (sha256(output) !== change.outputSha256) throw new Error(`plan output digest mismatch: ${change.path}`);
    atomicReplace(path, output);
    changed++;
  }
  const cold = applyColdArchiveDispositions(plan, archiveMacKey);
  return {
    changed,
    alreadyApplied,
    legacyMoved: cold.moved,
    legacyAlreadyMoved: cold.alreadyMoved,
    coldManifest: cold.manifest,
  };
}

export function verifyStrictArchive(options: AuditOptions, plan?: ArchiveMigrationPlan): ArchiveMigrationPlan {
  const archivePath = realExistingDirectory(options.archiveDir);
  // Verification is part of the offline migration critical section. Without
  // this lock, a service could publish a record between the audit and the
  // planned-final-state comparison, making a successful check meaningless.
  assertOffline(archivePath);
  return withMigrationOwnership(archivePath, () =>
    verifyStrictArchiveOwned({ ...options, archiveDir: archivePath }, plan),
  );
}

function verifyStrictArchiveOwned(
  options: AuditOptions,
  plan?: ArchiveMigrationPlan,
): ArchiveMigrationPlan {
  const result = auditArchive({
    ...options,
    // The locks are owned by this verifier; do not turn our own markers into
    // unknown-file findings while preserving all other writer-artifact checks.
    ignoreOwnedMigrationLocks: true,
  });
  if (plan) {
    verifyPlan(plan, options.archiveMacKey);
    if (result.archivePath !== plan.archivePath) throw new Error("verification archive differs from plan");
    if (result.legacyArchiveKeyFingerprint !== plan.legacyArchiveKeyFingerprint) {
      throw new Error("verification legacy archive key fingerprint differs from plan");
    }
    if (result.replayKeyFingerprint !== plan.replayKeyFingerprint) {
      throw new Error("verification replay key fingerprint differs from plan");
    }
    if (result.pinnedSigningKey !== plan.pinnedSigningKey) {
      throw new Error("verification signing key differs from plan");
    }
  }
  const strictErrors = [
    ...result.findings.filter((item) => item.severity === "error"),
    ...privateInventoryFindings(result.inventory),
  ];
  if (result.counts.unsignedRecords || result.counts.unsignedClaims || result.changes.length || result.counts.legacyRecords) {
    strictErrors.push({
      severity: "error",
      code: "strict_incomplete",
      message: "current records or claims remain unsigned, or legacy v1 records remain in the strict archive",
    });
  }
  if (strictErrors.length) {
    const summary = strictErrors.slice(0, 5).map((item) => `${item.code}${item.path ? ` (${item.path})` : ""}`).join(", ");
    throw new Error(`strict verification failed: ${summary}`);
  }
  if (plan) {
    verifyPlannedFinalInventory(result, plan);
    if (plan.legacyDispositions.length) {
      if (!plan.coldArchivePath) throw new Error("planned legacy disposition has no cold archive");
      const manifestPath = join(plan.coldArchivePath, COLD_MANIFEST_NAME);
      if (!existsSync(manifestPath)) throw new Error("planned cold archive manifest is missing");
      const manifest = parseColdManifestFile(manifestPath);
      verifyColdManifest(manifest, plan, options.archiveMacKey!);
    }
  }
  return result;
}

function applyColdArchiveDispositions(
  plan: ArchiveMigrationPlan,
  archiveMacKey: string,
): { moved: number; alreadyMoved: number; manifest: ArchiveColdManifest | null } {
  if (!plan.legacyDispositions.length) {
    return { moved: 0, alreadyMoved: 0, manifest: null };
  }
  if (!plan.coldArchivePath) throw new Error("legacy records remain but no cold archive was planned");
  if (
    !plan.approvalReviewDigest ||
    plan.legacyDispositions.some((item) => item.evidence !== "operator-approval") ||
    plan.counts.approvedLegacyRecords !== plan.legacyDispositions.length
  ) {
    throw new Error("every legacy disposition requires plan-bound approve-review authorization");
  }
  const archivePath = realExistingDirectory(plan.archivePath);
  const coldPath = prepareColdArchiveDirectory(plan.coldArchivePath, archivePath);
  const expectedFiles = plan.legacyDispositions
    .map((item) => ({ path: item.path, sha256: item.inputSha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifestPath = join(coldPath, COLD_MANIFEST_NAME);
  let existingManifest: ArchiveColdManifest | null = null;
  if (existsSync(manifestPath)) {
    existingManifest = parseColdManifestFile(manifestPath);
    verifyColdManifest(existingManifest, plan, archiveMacKey, true);
  } else {
    assertColdArchiveContents(coldPath, new Set());
    existingManifest = createColdManifest(plan, coldPath, expectedFiles, "prepared", archiveMacKey);
    writeJsonExclusive(manifestPath, existingManifest);
    syncTreeDirectories(coldPath);
  }

  let moved = 0;
  let alreadyMoved = 0;
  for (const item of expectedFiles) {
    const source = join(archivePath, safeRelativePath(item.path));
    const destination = join(coldPath, safeRelativePath(item.path));
    const sourceExists = existsSync(source);
    const destinationExists = existsSync(destination);
    if (sourceExists && sha256(readFileSync(source)) !== item.sha256) {
      throw new Error(`legacy source changed: ${item.path}`);
    }
    if (destinationExists && sha256(readFileSync(destination)) !== item.sha256) {
      throw new Error(`cold archive file checksum mismatch: ${item.path}`);
    }
    if (!sourceExists && !destinationExists) {
      throw new Error(`legacy record is absent from active and cold archives: ${item.path}`);
    }
    if (!destinationExists) {
      copyFileDurable(source, destination);
      if (sha256(readFileSync(destination)) !== item.sha256) {
        throw new Error(`cold archive copy verification failed: ${item.path}`);
      }
    }
    if (sourceExists) {
      unlinkSync(source);
      syncDirectory(archivePath);
      moved++;
    } else {
      alreadyMoved++;
    }
  }

  if (existingManifest.status === "complete") {
    return { moved, alreadyMoved, manifest: existingManifest };
  }
  const complete = createColdManifest(plan, coldPath, expectedFiles, "complete", archiveMacKey);
  atomicReplace(manifestPath, Buffer.from(`${JSON.stringify(complete, null, 2)}\n`));
  syncTreeDirectories(coldPath);
  verifyColdManifest(complete, plan, archiveMacKey);
  return { moved, alreadyMoved, manifest: complete };
}

function createColdManifest(
  plan: ArchiveMigrationPlan,
  coldPath: string,
  files: Array<{ path: string; sha256: string }>,
  status: ArchiveColdManifest["status"],
  archiveMacKey: string,
): ArchiveColdManifest {
  const unsigned = {
    version: ARCHIVE_COLD_MANIFEST_VERSION,
    archivePath: plan.archivePath,
    coldArchivePath: coldPath,
    createdAt: new Date().toISOString(),
    planDigest: plan.planDigest,
    sourceInventoryDigest: plan.inventoryDigest,
    status,
    files,
    filesDigest: digestObject(files),
  } as const;
  const manifestDigest = digestObject(unsigned);
  return {
    ...unsigned,
    manifestDigest,
    manifestMac: keyedDigest(COLD_MANIFEST_MAC_CONTEXT, manifestDigest, archiveMacKey)!,
  };
}

export function verifyColdManifest(
  manifest: ArchiveColdManifest,
  plan: ArchiveMigrationPlan,
  archiveMacKey: string,
  allowPrepared = false,
): void {
  assertMigrationPlanShape(plan);
  assertColdManifestShape(manifest);
  if (manifest.version !== ARCHIVE_COLD_MANIFEST_VERSION) {
    throw new Error("unsupported cold archive manifest version");
  }
  const { manifestDigest, manifestMac, ...unsigned } = manifest;
  if (digestObject(unsigned) !== manifestDigest) throw new Error("cold archive manifest digest mismatch");
  const expectedMac = keyedDigest(COLD_MANIFEST_MAC_CONTEXT, manifestDigest, archiveMacKey);
  if (!expectedMac || !safeEqual(expectedMac, manifestMac)) {
    throw new Error("cold archive manifest authentication failed");
  }
  if (
    manifest.archivePath !== plan.archivePath ||
    manifest.coldArchivePath !== plan.coldArchivePath ||
    manifest.planDigest !== plan.planDigest ||
    manifest.sourceInventoryDigest !== plan.inventoryDigest
  ) {
    throw new Error("cold archive manifest does not authorize this plan");
  }
  if (manifest.filesDigest !== digestObject(manifest.files)) {
    throw new Error("cold archive file inventory digest mismatch");
  }
  const expected = plan.legacyDispositions
    .map((item) => ({ path: item.path, sha256: item.inputSha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalValue(manifest.files) !== canonicalValue(expected)) {
    throw new Error("cold archive manifest has a different file set");
  }
  const coldPath = realExistingDirectory(manifest.coldArchivePath);
  assertPrivateDirectory(coldPath, "cold archive");
  if (manifest.status !== "complete" && !(allowPrepared && manifest.status === "prepared")) {
    throw new Error("cold archive manifest is not complete");
  }
  assertColdArchiveContents(coldPath, new Set([COLD_MANIFEST_NAME, ...manifest.files.map((item) => item.path)]));
  for (const item of manifest.files) {
    const path = join(coldPath, safeRelativePath(item.path));
    if (!existsSync(path)) {
      if (allowPrepared && manifest.status === "prepared") continue;
      throw new Error(`cold archive file no longer matches its manifest: ${item.path}`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(readFileSync(path)) !== item.sha256) {
      throw new Error(`cold archive file no longer matches its manifest: ${item.path}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`cold archive file must not be group- or world-accessible: ${item.path}`);
    }
  }
  const manifestStat = lstatSync(join(coldPath, COLD_MANIFEST_NAME));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o077) !== 0) {
    throw new Error("cold archive manifest must be a private regular file");
  }
}

export function readPlan(path: string): ArchiveMigrationPlan {
  const value = parseJsonFile(path, "migration plan");
  assertMigrationPlanShape(value);
  return value;
}

export function readApproval(path: string): ArchiveApproval {
  const value = parseJsonFile(path, "archive approval");
  assertApprovalShape(value);
  return value;
}

export function readBackupManifest(path: string): ArchiveBackupManifest {
  const value = parseJsonFile(path, "backup manifest");
  assertBackupManifestShape(value);
  return value;
}

export function readApprovalReview(path: string): ArchiveApprovalReview {
  const value = parseJsonFile(path, "approval review");
  assertApprovalReviewShape(value);
  return value;
}

export function writeJsonExclusive(path: string, value: unknown): void {
  const target = resolve(path);
  const requestedParent = dirname(target);
  const parentFd = openPrivateDirectoryPath(requestedParent);
  const anchoredTarget = `/proc/self/fd/${parentFd}/${basename(target)}`;
  let fd: number | undefined;
  try {
    const parentStat = fstatSync(parentFd);
    fd = openSync(
      anchoredTarget,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const currentParent = statSync(requestedParent);
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino) {
      try { unlinkSync(anchoredTarget); } catch { /* preserve the race error */ }
      throw new Error("output parent changed while the artifact was being written");
    }
    fsyncSync(parentFd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(parentFd);
  }
}

/** Walk the output parent one component at a time through directory file
 * descriptors. `mkdir -p` followed by `realpath` leaves a window where an
 * attacker can replace an ancestor with a symlink; descriptor-relative paths
 * keep every subsequent operation anchored to the directory we inspected. */
function openPrivateDirectoryPath(path: string): number {
  if (process.platform !== "linux" || !existsSync("/proc/self/fd")) {
    throw new Error("safe migration artifact writes require Linux /proc/self/fd support");
  }
  const resolved = resolve(path);
  const root = parse(resolved).root;
  let currentFd = openSync(
    root,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const components = relative(root, resolved).split(sep).filter(Boolean);
    for (const component of components) {
      const anchored = `/proc/self/fd/${currentFd}/${component}`;
      try {
        mkdirSync(anchored, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const before = lstatSync(anchored);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error("output parent contains a symlink or non-directory component");
      }
      const nextFd = openSync(
        anchored,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const opened = fstatSync(nextFd);
      if (before.dev !== opened.dev || before.ino !== opened.ino) {
        closeSync(nextFd);
        throw new Error("output parent changed while it was being opened");
      }
      closeSync(currentFd);
      currentFd = nextFd;
    }
    const finalStat = fstatSync(currentFd);
    if (!finalStat.isDirectory() || (finalStat.mode & 0o077) !== 0) {
      throw new Error("output parent must be a private directory");
    }
    return currentFd;
  } catch (error) {
    closeSync(currentFd);
    throw error;
  }
}

function validateApproval(
  approval: ArchiveApproval | undefined,
  archivePath: string,
  inventoryDigest: string,
  archiveMacKey: string | undefined,
): Set<string> {
  if (!approval) return new Set();
  assertApprovalShape(approval);
  if (approval.version !== ARCHIVE_APPROVAL_VERSION) throw new Error("unsupported approval version");
  const { approvalDigest, approvalMac, ...unsigned } = approval;
  if (digestObject(unsigned) !== approvalDigest) throw new Error("approval digest mismatch");
  const expected = keyedDigest(APPROVAL_MAC_CONTEXT, approvalDigest, archiveMacKey);
  if (!expected || !safeEqual(expected, approvalMac)) throw new Error("approval authentication failed");
  if (approval.archivePath !== archivePath || approval.inventoryDigest !== inventoryDigest) {
    throw new Error("approval is bound to a different archive snapshot");
  }
  return new Set(approval.approvedFiles.map((item) => `${safeRelativePath(item.path)}\0${item.sha256}`));
}

function parseJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseColdManifestFile(path: string): ArchiveColdManifest {
  const value = parseJsonFile(path, "cold archive manifest");
  assertColdManifestShape(value);
  return value;
}

function assertMigrationPlanShape(value: unknown): asserts value is ArchiveMigrationPlan {
  const plan = objectWithKeys(value, [
    "version", "archivePath", "createdAt", "inventory", "inventoryDigest",
    "archiveKeyFingerprint", "legacyArchiveKeyFingerprint", "replayKeyFingerprint", "pinnedSigningKey",
    "approvalDigest", "approvalReviewDigest", "coldArchivePath", "counts",
    "findings", "changes", "legacyDispositions", "planDigest", "planMac",
  ], "migration plan");
  requireString(plan.version, "migration plan version");
  requireString(plan.archivePath, "migration plan archivePath");
  requireString(plan.createdAt, "migration plan createdAt");
  requireSha256(plan.inventoryDigest, "migration plan inventoryDigest");
  requireNullableSha256(plan.archiveKeyFingerprint, "migration plan archiveKeyFingerprint");
  requireNullableSha256(plan.legacyArchiveKeyFingerprint, "migration plan legacyArchiveKeyFingerprint");
  requireNullableSha256(plan.replayKeyFingerprint, "migration plan replayKeyFingerprint");
  requireNullableString(plan.pinnedSigningKey, "migration plan pinnedSigningKey");
  requireNullableSha256(plan.approvalDigest, "migration plan approvalDigest");
  requireNullableSha256(plan.approvalReviewDigest, "migration plan approvalReviewDigest");
  requireNullableString(plan.coldArchivePath, "migration plan coldArchivePath");
  requireSha256(plan.planDigest, "migration plan planDigest");
  requireNullableSha256(plan.planMac, "migration plan planMac");
  if (!Array.isArray(plan.inventory)) throw new Error("migration plan inventory must be an array");
  plan.inventory.forEach((entry, index) => assertInventoryEntryShape(entry, `migration plan inventory[${index}]`));
  const counts = objectWithKeys(plan.counts, [
    "files", "records", "legacyRecords", "claims", "replayStates", "replayHolds",
    "unsignedRecords", "unsignedClaims", "approvedRecords", "approvedLegacyRecords",
    "nonCanonicalTransactions", "changes", "legacyDispositions", "errors", "warnings",
  ], "migration plan counts");
  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`migration plan count is invalid: ${name}`);
    }
  }
  if (!Array.isArray(plan.findings)) throw new Error("migration plan findings must be an array");
  plan.findings.forEach((finding, index) => {
    const item = objectWithKeys(finding, ["severity", "code", "message"], `migration plan findings[${index}]`, ["path"]);
    if (!["error", "warning", "info"].includes(String(item.severity))) throw new Error("migration finding severity is invalid");
    requireString(item.code, "migration finding code");
    requireString(item.message, "migration finding message");
    if (item.path !== undefined) safeRelativePath(requireString(item.path, "migration finding path"));
  });
  if (!Array.isArray(plan.changes)) throw new Error("migration plan changes must be an array");
  plan.changes.forEach((change, index) => {
    const item = objectWithKeys(change, [
      "path", "kind", "inputSha256", "outputSha256", "outputBase64",
      "approvalRequired", "evidence",
    ], `migration plan changes[${index}]`);
    safeRelativePath(requireString(item.path, "migration change path"));
    if (!["claim", "record"].includes(String(item.kind))) throw new Error("migration change kind is invalid");
    requireSha256(item.inputSha256, "migration change inputSha256");
    requireSha256(item.outputSha256, "migration change outputSha256");
    requireBase64(item.outputBase64, "migration change outputBase64");
    if (typeof item.approvalRequired !== "boolean") throw new Error("migration change approvalRequired is invalid");
    if (!["current-mac", "signed-json", "operator-approval"].includes(String(item.evidence))) {
      throw new Error("migration change evidence is invalid");
    }
  });
  if (!Array.isArray(plan.legacyDispositions)) throw new Error("migration plan legacyDispositions must be an array");
  plan.legacyDispositions.forEach((disposition, index) => {
    const item = objectWithKeys(disposition, [
      "path", "inputSha256", "approvalRequired", "evidence",
    ], `migration plan legacyDispositions[${index}]`);
    safeRelativePath(requireString(item.path, "legacy disposition path"));
    requireSha256(item.inputSha256, "legacy disposition inputSha256");
    if (item.approvalRequired !== true) throw new Error("legacy disposition approvalRequired is invalid");
    if (!["operator-approval", "unapproved"].includes(String(item.evidence))) {
      throw new Error("legacy disposition evidence is invalid");
    }
  });
}

function assertApprovalShape(value: unknown): asserts value is ArchiveApproval {
  const approval = objectWithKeys(value, [
    "version", "archivePath", "inventoryDigest", "planDigest", "coldArchivePath",
    "approvedFiles", "approvalDigest", "approvalMac",
  ], "archive approval");
  requireString(approval.version, "approval version");
  requireString(approval.archivePath, "approval archivePath");
  requireSha256(approval.inventoryDigest, "approval inventoryDigest");
  requireNullableSha256(approval.planDigest, "approval planDigest");
  requireNullableString(approval.coldArchivePath, "approval coldArchivePath");
  requireSha256(approval.approvalDigest, "approval digest");
  requireSha256(approval.approvalMac, "approval MAC");
  if (!Array.isArray(approval.approvedFiles)) throw new Error("approval approvedFiles must be an array");
  approval.approvedFiles.forEach((file, index) => {
    const item = objectWithKeys(file, ["path", "sha256", "reason"], `approval approvedFiles[${index}]`);
    safeRelativePath(requireString(item.path, "approval file path"));
    requireSha256(item.sha256, "approval file sha256");
    if (!requireString(item.reason, "approval file reason").trim()) throw new Error("approval file reason is empty");
  });
}

function assertApprovalReviewShape(value: unknown): asserts value is ArchiveApprovalReview {
  const review = objectWithKeys(value, [
    "version", "archivePath", "reviewDigest", "inventoryDigest", "coldArchivePath", "files",
  ], "approval review");
  requireString(review.version, "approval review version");
  requireString(review.archivePath, "approval review archivePath");
  requireSha256(review.reviewDigest, "approval review digest");
  requireSha256(review.inventoryDigest, "approval review inventoryDigest");
  requireNullableString(review.coldArchivePath, "approval review coldArchivePath");
  if (!Array.isArray(review.files)) throw new Error("approval review files must be an array");
  review.files.forEach((file, index) => {
    const item = objectWithKeys(file, ["path", "sha256", "actions"], `approval review files[${index}]`);
    safeRelativePath(requireString(item.path, "approval review file path"));
    requireSha256(item.sha256, "approval review file sha256");
    if (!Array.isArray(item.actions) || !item.actions.length || item.actions.some((action) =>
      action !== "authenticate-record" &&
      action !== "authenticate-claim" &&
      action !== "move-legacy-to-cold-archive"
    )) {
      throw new Error("approval review file actions are invalid");
    }
  });
}

function assertBackupManifestShape(value: unknown): asserts value is ArchiveBackupManifest {
  const manifest = objectWithKeys(value, [
    "version", "archivePath", "backupPath", "createdAt", "planDigest",
    "sourceInventoryDigest", "backupInventoryDigest", "files", "manifestDigest", "manifestMac",
  ], "backup manifest");
  requireString(manifest.version, "backup manifest version");
  requireString(manifest.archivePath, "backup manifest archivePath");
  requireString(manifest.backupPath, "backup manifest backupPath");
  requireString(manifest.createdAt, "backup manifest createdAt");
  requireSha256(manifest.planDigest, "backup manifest planDigest");
  requireSha256(manifest.sourceInventoryDigest, "backup manifest sourceInventoryDigest");
  requireSha256(manifest.backupInventoryDigest, "backup manifest backupInventoryDigest");
  if (!Number.isSafeInteger(manifest.files) || (manifest.files as number) < 0) throw new Error("backup manifest files is invalid");
  requireSha256(manifest.manifestDigest, "backup manifest digest");
  requireSha256(manifest.manifestMac, "backup manifest MAC");
}

function assertColdManifestShape(value: unknown): asserts value is ArchiveColdManifest {
  const manifest = objectWithKeys(value, [
    "version", "archivePath", "coldArchivePath", "createdAt", "planDigest",
    "sourceInventoryDigest", "status", "files", "filesDigest", "manifestDigest", "manifestMac",
  ], "cold archive manifest");
  requireString(manifest.version, "cold manifest version");
  requireString(manifest.archivePath, "cold manifest archivePath");
  requireString(manifest.coldArchivePath, "cold manifest coldArchivePath");
  requireString(manifest.createdAt, "cold manifest createdAt");
  requireSha256(manifest.planDigest, "cold manifest planDigest");
  requireSha256(manifest.sourceInventoryDigest, "cold manifest sourceInventoryDigest");
  if (manifest.status !== "prepared" && manifest.status !== "complete") throw new Error("cold manifest status is invalid");
  if (!Array.isArray(manifest.files)) throw new Error("cold manifest files must be an array");
  manifest.files.forEach((file, index) => {
    const item = objectWithKeys(file, ["path", "sha256"], `cold manifest files[${index}]`);
    safeRelativePath(requireString(item.path, "cold manifest file path"));
    requireSha256(item.sha256, "cold manifest file sha256");
  });
  requireSha256(manifest.filesDigest, "cold manifest filesDigest");
  requireSha256(manifest.manifestDigest, "cold manifest digest");
  requireSha256(manifest.manifestMac, "cold manifest MAC");
}

function assertInventoryEntryShape(value: unknown, label: string): void {
  const entry = objectWithKeys(value, ["path", "kind", "mode", "size"], label, ["sha256", "target"]);
  safeRelativePath(requireString(entry.path, `${label} path`));
  if (!["file", "directory", "symlink", "special"].includes(String(entry.kind))) throw new Error(`${label} kind is invalid`);
  if (!Number.isSafeInteger(entry.mode) || (entry.mode as number) < 0) throw new Error(`${label} mode is invalid`);
  if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) throw new Error(`${label} size is invalid`);
  if (entry.kind === "file") requireSha256(entry.sha256, `${label} sha256`);
  else if (entry.sha256 !== undefined) throw new Error(`${label} has an unexpected sha256`);
  if (entry.kind === "symlink") requireString(entry.target, `${label} target`);
  else if (entry.target !== undefined) throw new Error(`${label} has an unexpected target`);
}

function objectWithKeys(
  value: unknown,
  required: string[],
  label: string,
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(object).some((key) => !allowed.has(key)) || required.some((key) => !(key in object))) {
    throw new Error(`${label} has an invalid shape`);
  }
  return object;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireNullableString(value: unknown, label: string): void {
  if (value !== null) requireString(value, label);
}

function requireSha256(value: unknown, label: string): void {
  if (typeof value !== "string" || !LOWER_SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function requireNullableSha256(value: unknown, label: string): void {
  if (value !== null) requireSha256(value, label);
}

function requireBase64(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be valid base64`);
  }
}

function recordShapeError(value: unknown, name: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "record must be a JSON object";
  const record = value as Partial<ArchiveRecord>;
  if (typeof record.id !== "string" || !RECORD_ID_PATTERN.test(record.id)) return "record id is invalid";
  if (`${record.id}.json` !== name) return "record id does not match its filename";
  if (!record.request || typeof record.request !== "object" || Array.isArray(record.request)) return "record request is invalid";
  if (typeof record.paramsSha256 !== "string" || !SHA256_PATTERN.test(record.paramsSha256)) return "paramsSha256 is invalid";
  if (record.resolvedParamsSha256 !== undefined && !SHA256_PATTERN.test(record.resolvedParamsSha256)) return "resolvedParamsSha256 is invalid";
  if (typeof record.contentType !== "string" || typeof record.deliverable !== "string") return "record content is invalid";
  if (typeof record.deliveredAt !== "string" || !Number.isFinite(Date.parse(record.deliveredAt))) return "deliveredAt is invalid";
  if (
    record.paymentTransaction !== undefined &&
    (typeof record.paymentTransaction !== "string" ||
      record.paymentTransaction === "" ||
      record.paymentTransaction.trim() !== record.paymentTransaction)
  ) return "payment transaction is invalid";
  if (record.settlement !== undefined && !validConfirmedSettlement(record.settlement, record.paymentTransaction)) return "confirmed settlement is invalid";
  if (record.jobId !== undefined && (typeof record.jobId !== "string" || !/^0x[a-f0-9]{64}$/i.test(record.jobId))) return "jobId is invalid";
  if (record.recoveryCodeSha256 !== undefined && !SHA256_PATTERN.test(record.recoveryCodeSha256)) return "recovery-code hash is invalid";
  if (record.mac !== undefined && (typeof record.mac !== "string" || !SHA256_PATTERN.test(record.mac))) return "record MAC is invalid";
  return null;
}

/**
 * An unsigned claim may inherit authority from a record only when it repeats
 * the record's transaction and settlement metadata exactly. `mergedClaimRecord`
 * is deliberately more permissive because a separately authenticated claim
 * can enrich a staged record after a crash; migration must not confuse that
 * repair capability with permission to create a new authenticated claim.
 */
function claimMetadataMatchesRecord(
  record: ArchiveRecord,
  claim: TransactionClaim,
): boolean {
  const transaction = record.settlement?.transaction ?? record.paymentTransaction;
  return Boolean(
    transaction &&
      transaction.toLowerCase() === claim.transaction.toLowerCase() &&
      settlementSame(record.settlement, claim.settlement),
  );
}

function isLegacyRecord(value: unknown, name: string): boolean {
  if (!/^[a-f0-9]{64}\.json$/i.test(name) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.id === undefined &&
    typeof record.paramsSha256 === "string" &&
    `${record.paramsSha256}.json`.toLowerCase() === name.toLowerCase() &&
    typeof record.deliverable === "string" &&
    typeof record.contentType === "string" &&
    typeof record.deliveredAt === "string" &&
    record.request !== null &&
    typeof record.request === "object" &&
    !Array.isArray(record.request)
  );
}

function signedJsonEvidence(record: ArchiveRecord, pinnedKey: string | undefined): boolean {
  if (record.contentType !== "application/json" || !pinnedKey) return false;
  try {
    const report = JSON.parse(record.deliverable) as Record<string, unknown>;
    const attestation = report.attestation as Attestation | undefined;
    if (!attestation || !verifyAttestation(attestation, pinnedKey).verified) return false;
    const { attestation: _attestation, ...body } = report;
    return (
      typeof attestation.payload?.reportSha256 === "string" &&
      sha256(canonicalJson(body)) === attestation.payload.reportSha256 &&
      attestation.payload.requestSha256 === record.resolvedParamsSha256
    );
  } catch {
    return false;
  }
}

function parseReplayState(bytes: Buffer, fingerprint: string, secret: string | undefined): ReplayState | null {
  if (!secret) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as ReplayState;
  const createdAt = replayTimestamp(state.createdAt);
  const updatedAt = replayTimestamp(state.updatedAt);
  const reasons = new Set(["settlement_unreachable", "settlement_timeout", "receipt_unconfirmed", "archive_link_failed", "replay_commit_failed"]);
  if (
    state.v !== 1 || state.fingerprint !== fingerprint || !LOWER_SHA256_PATTERN.test(fingerprint) ||
    !["pending", "unknown", "confirmed"].includes(state.status) ||
    typeof state.attemptToken !== "string" || !/^[a-f0-9]{32}$/.test(state.attemptToken) ||
    !state.request || typeof state.request.paramsSha256 !== "string" ||
    !LOWER_SHA256_PATTERN.test(state.request.paramsSha256) ||
    !["text/html", "application/json", "invalid"].includes(state.request.contentType) ||
    !state.requirements || !["scheme", "network", "amount", "asset", "payTo"].every((key) => typeof state.requirements[key as keyof ReplayState["requirements"]] === "string" && state.requirements[key as keyof ReplayState["requirements"]] !== "") ||
    createdAt === null || updatedAt === null || updatedAt < createdAt ||
    (state.ownerPid !== undefined && (!Number.isSafeInteger(state.ownerPid) || state.ownerPid < 1)) ||
    (state.ownerStartedAt !== undefined && (!Number.isSafeInteger(state.ownerStartedAt) || state.ownerStartedAt < 1)) ||
    (state.ownerToken !== undefined && (typeof state.ownerToken !== "string" || !/^[a-f0-9]{32}$/.test(state.ownerToken))) ||
    (state.reportId !== undefined &&
      (typeof state.reportId !== "string" || !RECORD_ID_PATTERN.test(state.reportId))) ||
    typeof state.mac !== "string" || !LOWER_SHA256_PATTERN.test(state.mac)
  ) return null;
  if (state.status === "pending" && (state.reason !== undefined || state.settlement !== undefined || state.settlementEvidence !== undefined)) return null;
  if (state.status === "pending") {
    const ownerFields = [state.ownerPid, state.ownerStartedAt, state.ownerToken];
    if (ownerFields.some((value) => value !== undefined) && ownerFields.some((value) => value === undefined)) return null;
  } else if (state.ownerPid !== undefined || state.ownerStartedAt !== undefined || state.ownerToken !== undefined) {
    return null;
  }
  if (state.status === "unknown") {
    if (!state.reason || !reasons.has(state.reason) || !state.reportId) return null;
    if (state.reason === "replay_commit_failed" && !validReplaySettlement(state.settlement)) return null;
    if (state.settlement !== undefined && !validReplaySettlement(state.settlement)) return null;
    if (
      state.settlementEvidence !== undefined &&
      state.settlementEvidence !== "candidate" &&
      state.settlementEvidence !== "confirmed"
    ) return null;
    if (state.settlement === undefined && state.settlementEvidence !== undefined) return null;
    if (state.reason === "archive_link_failed" || state.reason === "replay_commit_failed") {
      if (state.settlement !== undefined && state.settlementEvidence !== "confirmed") return null;
    } else if (state.settlement !== undefined && state.settlementEvidence !== "candidate") {
      return null;
    }
  }
  if (state.status === "confirmed" && (state.reason !== undefined || state.settlementEvidence !== undefined || !state.reportId || !validReplaySettlement(state.settlement))) return null;
  const { mac, ...unsigned } = state;
  const expected = replayMac(unsigned, secret);
  return safeEqual(mac, expected) ? state : null;
}

function replayTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function parseReplayHold(bytes: Buffer, secret: string | undefined): ReplayHold | null {
  if (!secret) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hold = value as ReplayHold;
  if (Object.keys(hold).sort().join(",") !== "attemptToken,fingerprint,mac,reportId,v") return null;
  if (
    hold.v !== 1 ||
    typeof hold.reportId !== "string" ||
    !RECORD_ID_PATTERN.test(hold.reportId) ||
    typeof hold.fingerprint !== "string" ||
    !LOWER_SHA256_PATTERN.test(hold.fingerprint) ||
    typeof hold.attemptToken !== "string" ||
    !/^[a-f0-9]{32}$/.test(hold.attemptToken) ||
    typeof hold.mac !== "string" ||
    !LOWER_SHA256_PATTERN.test(hold.mac)
  ) return null;
  const expected = replayMac({ v: 1, reportId: hold.reportId, fingerprint: hold.fingerprint, attemptToken: hold.attemptToken }, secret);
  return safeEqual(hold.mac, expected) ? hold : null;
}

function validReplaySettlement(value: unknown): value is Omit<ConfirmedSettlement, "status"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settlement = value as Record<string, unknown>;
  return typeof settlement.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) && typeof settlement.network === "string" && settlement.network !== "" && (settlement.amount === undefined || typeof settlement.amount === "string") && (settlement.payer === undefined || (typeof settlement.payer === "string" && /^0x[0-9a-fA-F]{40}$/.test(settlement.payer)));
}

function validateReplayLinks(
  findings: MigrationFinding[],
  records: Map<string, ParsedRecord>,
  transactionOwners: Map<string, string>,
  states: Map<string, { name: string; state: ReplayState }>,
  holds: Array<{ name: string; hold: ReplayHold }>,
): void {
  const byReport = new Map<string, { name: string; hold: ReplayHold }>();
  for (const item of holds) {
    const expectedName = `.report-${item.hold.reportId.toLowerCase()}.replay-hold`;
    const state = states.get(item.hold.fingerprint)?.state;
    if (item.name !== expectedName || !records.has(item.hold.reportId) || !state || state.attemptToken !== item.hold.attemptToken || state.reportId !== item.hold.reportId) {
      finding(findings, "error", "replay_hold_owner_mismatch", "replay hold does not match its report and replay state", item.name);
    }
    if (byReport.has(item.hold.reportId)) finding(findings, "error", "duplicate_replay_hold", "multiple holds reference one report", item.name);
    byReport.set(item.hold.reportId, item);
  }
  const confirmedOwners = new Map<string, string>();
  for (const { name, state } of states.values()) {
    if (state.reportId && state.status !== "confirmed" && !byReport.has(state.reportId)) {
      finding(findings, "error", "replay_hold_missing", "non-confirmed replay with a report lacks its retention hold", name);
    }
    if (state.reportId && !records.has(state.reportId)) {
      finding(findings, "error", "replay_report_missing", "replay state references a missing report", name);
    }
    if (state.status === "confirmed" && state.reportId && state.settlement) {
      const ownerId = transactionOwners.get(state.settlement.transaction.toLowerCase());
      const owner = ownerId ? records.get(ownerId)?.record : undefined;
      const asConfirmed: ConfirmedSettlement = { status: "confirmed", ...state.settlement };
      if (ownerId !== state.reportId || !owner?.settlement || !settlementSame(owner.settlement, asConfirmed)) {
        finding(findings, "error", "confirmed_replay_owner_mismatch", "confirmed replay does not resolve to the authoritative settled owner", name);
      }
      const prior = confirmedOwners.get(state.settlement.transaction.toLowerCase());
      if (prior && prior !== state.fingerprint) {
        finding(findings, "warning", "duplicate_confirmed_replay", "multiple replay states reference one confirmed transaction", name);
      }
      confirmedOwners.set(state.settlement.transaction.toLowerCase(), state.fingerprint);
    }
  }
}

function scanInventory(root: string): ScanResult {
  const inventory: MigrationInventoryEntry[] = [];
  walk(root, "", inventory);
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  return { inventory, digest: digestObject(inventory) };
}

function walk(root: string, prefix: string, out: MigrationInventoryEntry[]): void {
  const dir = join(root, prefix);
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of entries) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const path = join(root, rel);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      out.push({ path: rel, kind: "symlink", mode: stat.mode & 0o7777, size: stat.size, target: readlinkSync(path) });
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      out.push({ path: rel, kind: "file", mode: stat.mode & 0o7777, size: bytes.length, sha256: sha256(bytes) });
    } else if (stat.isDirectory()) {
      out.push({ path: rel, kind: "directory", mode: stat.mode & 0o7777, size: stat.size });
      walk(root, rel, out);
    } else {
      out.push({ path: rel, kind: "special", mode: stat.mode & 0o7777, size: stat.size });
    }
  }
}

function assertOffline(archivePath: string): void {
  const scan = scanInventory(archivePath);
  const blockers = scan.inventory.filter((entry) =>
    entry.path === ARCHIVE_LOCK_NAME ||
    entry.path === MIGRATION_LOCK_NAME ||
    /(^|\/)\.?(?:archive|payment|record|transaction|job)-.*\.lock(?:\/|$)/.test(entry.path) ||
    /\.tmp$/.test(entry.path) ||
    /\.reclaim-/.test(entry.path),
  );
  if (blockers.length) throw new Error(`archive has active or unresolved writer artifacts: ${blockers[0]!.path}`);
  if (process.env.DOSSIER_SERVICE_ACTIVE && process.env.DOSSIER_SERVICE_ACTIVE !== "0") {
    throw new Error("Dossier service is marked active; stop it before backup or apply");
  }
  assertNoLiveServiceLease(archivePath);
}

function withMigrationLocks<T>(archivePath: string, action: () => T): T {
  return withMigrationOwnership(archivePath, () => {
    const archive = join(archivePath, ARCHIVE_LOCK_NAME);
    acquireExclusiveLock(archive);
    try { return action(); } finally { releaseExclusiveLock(archive); }
  });
}

function withMigrationOwnership<T>(archivePath: string, action: () => T): T {
  const migration = join(archivePath, MIGRATION_LOCK_NAME);
  acquireExclusiveLock(migration);
  try {
    assertNoLiveServiceLease(archivePath);
    return action();
  } finally {
    releaseExclusiveLock(migration);
  }
}

function assertNoLiveServiceLease(archivePath: string): void {
  const lease = join(archivePath, ".archive-service.lock");
  if (existsSync(lease)) throw new Error("Dossier service lease is present; stop the service before backup or apply");
}

function acquireExclusiveLock(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  try {
    writeFileSync(join(path, "owner"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: randomBytes(16).toString("hex"), purpose: "archive-migration" }), { flag: "wx", mode: 0o600 });
    syncDirectory(dirname(path));
  } catch (error) {
    try { rmdirSync(path); } catch { /* preserve acquisition error */ }
    throw error;
  }
}

function releaseExclusiveLock(path: string): void {
  try { unlinkSync(join(path, "owner")); } catch { /* leave a visible blocker */ }
  try { rmdirSync(path); syncDirectory(dirname(path)); } catch { /* leave a visible blocker */ }
}

function atomicReplace(path: string, bytes: Buffer): void {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve failure */ }
    if (existsSync(temp)) try { unlinkSync(temp); } catch { /* preserve failure */ }
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncTreeDirectories(root: string): void {
  const directories = [root, ...scanInventory(root).inventory.filter((entry) => entry.kind === "directory").map((entry) => join(root, entry.path))].sort((a, b) => b.length - a.length);
  for (const path of directories) syncDirectory(path);
}

function separateExternalDirectory(path: string, archivePath: string, label: string): string {
  const candidate = canonicalPotentialPath(path);
  if (inside(candidate, archivePath) || inside(archivePath, candidate)) {
    throw new Error(`${label} must be outside and separate from ARCHIVE_DIR`);
  }
  return candidate;
}

function prepareColdArchiveDirectory(path: string, archivePath: string): string {
  const coldPath = separateExternalDirectory(path, archivePath, "cold archive");
  if (!existsSync(coldPath)) {
    mkdirSync(coldPath, { recursive: false, mode: 0o700 });
    syncDirectory(dirname(coldPath));
  }
  const realized = realExistingDirectory(coldPath);
  if (realized !== coldPath) throw new Error("cold archive destination changed while it was being prepared");
  assertPrivateDirectory(realized, "cold archive");
  return realized;
}

function assertColdArchiveContents(root: string, allowedFiles: Set<string>): void {
  const scan = scanInventory(root);
  for (const entry of scan.inventory) {
    if (entry.kind === "directory") continue;
    if (entry.kind !== "file" || !allowedFiles.has(entry.path)) {
      throw new Error(`unexpected or unsafe cold archive entry: ${entry.path}`);
    }
  }
  for (const entry of scan.inventory.filter((item) => item.kind === "directory")) {
    if (![...allowedFiles].some((path) => path.startsWith(`${entry.path}/`))) {
      throw new Error(`unexpected cold archive directory: ${entry.path}`);
    }
  }
}

function copyFileDurable(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  const fd = openSync(destination, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(destination));
}

function assertPrivateDirectory(path: string, label: string): void {
  const mode = lstatSync(path).mode & 0o7777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} must not be group- or world-accessible`);
  }
}

function coldDispositionPresent(plan: ArchiveMigrationPlan, path: string, archiveMacKey?: string): boolean {
  if (!plan.coldArchivePath) return false;
  const disposition = plan.legacyDispositions.find((item) => item.path === path);
  if (!disposition) return false;
  const manifestPath = join(plan.coldArchivePath, COLD_MANIFEST_NAME);
  if (!existsSync(manifestPath)) return false;
  const coldFile = join(plan.coldArchivePath, safeRelativePath(path));
  try {
    const manifest = parseColdManifestFile(manifestPath);
    if (!archiveMacKey) return false;
    verifyColdManifest(manifest, plan, archiveMacKey, true);
    return (
      (manifest.status === "prepared" || manifest.status === "complete") &&
      manifest.files.some((item) => item.path === path && item.sha256 === disposition.inputSha256) &&
      existsSync(coldFile) &&
      lstatSync(coldFile).isFile() &&
      !lstatSync(coldFile).isSymbolicLink() &&
      sha256(readFileSync(coldFile)) === disposition.inputSha256
    );
  } catch {
    return false;
  }
}

function realExistingDirectory(path: string): string {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("archive path must be a real directory, not a symlink");
  return realpathSync(resolved);
}

function canonicalPotentialPath(path: string): string {
  const candidate = resolve(path);
  let existing = candidate;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`path has no existing ancestor: ${candidate}`);
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function safeRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe relative path: ${path}`);
  return path;
}

function ownedMigrationEntry(archivePath: string, path: string): boolean {
  if (
    path !== MIGRATION_LOCK_NAME &&
    path !== `${MIGRATION_LOCK_NAME}/owner` &&
    path !== ARCHIVE_LOCK_NAME &&
    path !== `${ARCHIVE_LOCK_NAME}/owner`
  ) {
    return false;
  }
  const lockName = path.startsWith(MIGRATION_LOCK_NAME) ? MIGRATION_LOCK_NAME : ARCHIVE_LOCK_NAME;
  try {
    const owner = JSON.parse(readFileSync(join(archivePath, lockName, "owner"), "utf8")) as Record<string, unknown>;
    return owner.pid === process.pid && owner.purpose === "archive-migration";
  } catch {
    return false;
  }
}

function filteredInventory(entries: MigrationInventoryEntry[], archivePath: string): MigrationInventoryEntry[] {
  return entries.filter((entry) => !ownedMigrationEntry(archivePath, entry.path));
}

function inside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function isRecordName(path: string): boolean { return !path.includes("/") && !path.startsWith(".") && path.endsWith(".json"); }
function isClaimName(path: string): boolean { return /^\.tx-[a-f0-9]{64}\.claim$/.test(path); }
function isReplayStateName(path: string): boolean { return /^\.payment-[a-f0-9]{64}\.state$/.test(path); }
function isReplayHoldName(path: string): boolean { return /^\.report-[a-f0-9-]{8,64}\.replay-hold$/i.test(path); }

function replayKey(secret: string): Buffer { return createHash("sha256").update(`dossier-payment-replay:${secret}`).digest(); }
function replayMac(value: unknown, secret: string): string { return createHmac("sha256", replayKey(secret)).update(canonicalValue(value)).digest("hex"); }
function replayKeyFingerprint(secret: string | undefined): string | null { return secret ? createHash("sha256").update("dossier-payment-replay-key-fingerprint:").update(replayKey(secret)).digest("hex") : null; }
function digestObject(value: unknown): string { return sha256(canonicalValue(value)); }
function planBody(plan: ArchiveMigrationPlan): Omit<ArchiveMigrationPlan, "planDigest" | "planMac"> {
  const { planDigest: _planDigest, planMac: _planMac, ...body } = plan;
  return body;
}
function migrationReviewDigest(
  value: ArchiveMigrationPlan | Omit<ArchiveMigrationPlan, "planDigest" | "planMac">,
): string {
  const body = "planDigest" in value ? planBody(value) : value;
  return digestObject({
    version: body.version,
    archivePath: body.archivePath,
    inventoryDigest: body.inventoryDigest,
    archiveKeyFingerprint: body.archiveKeyFingerprint,
    legacyArchiveKeyFingerprint: body.legacyArchiveKeyFingerprint,
    replayKeyFingerprint: body.replayKeyFingerprint,
    pinnedSigningKey: body.pinnedSigningKey,
    coldArchivePath: body.coldArchivePath,
    reviewFiles: createReviewFiles(body),
  });
}

function verifyPlannedFinalInventory(
  actual: ArchiveMigrationPlan,
  plan: ArchiveMigrationPlan,
): void {
  const removed = new Set(plan.legacyDispositions.map((item) => item.path));
  const changes = new Map(plan.changes.map((item) => [item.path, item]));
  const expected = plan.inventory
    .filter((entry) => !removed.has(entry.path))
    .map((entry) => {
      const change = changes.get(entry.path);
      if (!change) return entry;
      if (entry.kind !== "file") throw new Error(`planned change does not target a file: ${entry.path}`);
      const output = Buffer.from(change.outputBase64, "base64");
      if (sha256(output) !== change.outputSha256) {
        throw new Error(`planned output digest mismatch during verification: ${entry.path}`);
      }
      return {
        ...entry,
        mode: 0o600,
        size: output.length,
        sha256: change.outputSha256,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const observed = [...actual.inventory].sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalValue(observed) !== canonicalValue(expected)) {
    throw new Error("strict archive bytes or permissions differ from the planned final state");
  }
}

function privateInventoryFindings(inventory: MigrationInventoryEntry[]): MigrationFinding[] {
  return inventory
    .filter((entry) => (entry.mode & 0o077) !== 0)
    .map((entry) => ({
      severity: "error" as const,
      code: "archive_permissions",
      message: "strict archive entries must not be group- or world-accessible",
      path: entry.path,
    }));
}

function createReviewFiles(
  plan: Pick<ArchiveMigrationPlan, "inventory" | "changes" | "legacyDispositions" | "findings">,
): ArchiveApprovalReview["files"] {
  type ReviewAction = ArchiveApprovalReview["files"][number]["actions"][number];
  const actions = new Map<string, Set<ReviewAction>>();
  for (const change of plan.changes) {
    if (!change.approvalRequired) continue;
    const current = actions.get(change.path) ?? new Set();
    current.add(change.kind === "claim" ? "authenticate-claim" : "authenticate-record");
    actions.set(change.path, current);
  }
  for (const disposition of plan.legacyDispositions) {
    const current = actions.get(disposition.path) ?? new Set();
    current.add("move-legacy-to-cold-archive");
    actions.set(disposition.path, current);
  }
  for (const item of plan.findings) {
    if (
      (item.code !== "record_unapproved" && item.code !== "claim_unapproved") ||
      !item.path
    ) {
      continue;
    }
    const current = actions.get(item.path) ?? new Set();
    current.add(
      item.code === "claim_unapproved" ? "authenticate-claim" : "authenticate-record",
    );
    actions.set(item.path, current);
  }
  return [...actions]
    .map(([path, fileActions]) => {
      const entry = plan.inventory.find((candidate) => candidate.path === path);
      if (!entry?.sha256) throw new Error(`approval review file is absent from inventory: ${path}`);
      return { path, sha256: entry.sha256, actions: [...fileActions].sort() };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
function keyedDigest(context: string, digest: string, secret: string | undefined): string | null { const key = secret ? createHash("sha256").update(`${context}${secret}`).digest() : null; return key ? createHmac("sha256", key).update(digest).digest("hex") : null; }
function safeEqual(a: string, b: string): boolean { try { const left = Buffer.from(a, "hex"); const right = Buffer.from(b, "hex"); return left.length === right.length && timingSafeEqual(left, right); } catch { return false; } }
function finding(findings: MigrationFinding[], severity: MigrationSeverity, code: string, message: string, path?: string): void { findings.push({ severity, code, message, ...(path ? { path } : {}) }); }
function findingOnce(findings: MigrationFinding[], reported: Set<string>, severity: MigrationSeverity, code: string, message: string): void { if (reported.has(code)) return; reported.add(code); finding(findings, severity, code, message); }
function requireCleanPlan(plan: ArchiveMigrationPlan): void { if (plan.counts.errors) throw new Error(`plan has ${plan.counts.errors} blocking finding(s)`); }
