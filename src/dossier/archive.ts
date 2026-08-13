// Durable archive of delivered reports, so a buyer who loses the paid response
// can fetch it again and prove it was not altered.
//
// A paid response can be lost for reasons that have nothing to do with us: the
// client crashes, the connection drops after settlement, the file is
// overwritten. Without this the buyer has paid and the artefact is gone, and we
// have no answer for them.
//
// Recovery is keyed on something the buyer holds because they bought: the
// settlement transaction for an x402 call, or the marketplace job id for a
// task-level purchase. Neither is a secret in the cryptographic sense — a
// determined observer could read a transfer to our payout address off-chain —
// so this is a guard against casual free reports, not a confidentiality
// boundary. It costs an attacker real effort to obtain a report on a token
// somebody else chose, when a full free sample is published anyway.
//
// Every delivery is its own record. Keying by the request instead would mean a
// second buyer asking about the same token silently destroyed the first
// buyer's record — and with it their only route to recovery.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { configureArchiveAdapter, inspectHold, reconcileHold } from "../payment-replay";
import {
  type ArchiveRecord,
  type TransactionClaim,
  archiveRecordDigest,
  archiveRecordMac,
  archiveRecordMacValid,
  mergedClaimRecord,
  settlementSame,
  transactionClaimMac,
  transactionClaimValid,
  transactionKey,
  validConfirmedSettlement,
  validTransactionHash,
} from "./archive-format";

export type { ArchiveRecord } from "./archive-format";

// Resolved on use, not at module load. Reading it at load time made the
// module's behaviour depend on import order, which is a trap: ESM hoists
// imports above assignments, so a caller that sets ARCHIVE_DIR before its
// `import` line still got the default, silently, and wrote somewhere else.
function configuredDir(): string {
  return (
    process.env.ARCHIVE_DIR ||
    join(process.env.HOME || process.env.TMPDIR || "/tmp", ".dossier-archive")
  );
}
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 5000;
const PRUNE_EVERY = 25;
// A lock is only held around a short synchronous filesystem transaction. If a
// worker dies while holding one, leaving the directory forever would turn one
// crash into a permanent archive outage. Reclaim only locks old enough that a
// healthy operation cannot still be inside its critical section.
const LOCK_STALE_MS = 30_000;
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);
const PROCESS_LOCK_TOKEN = randomBytes(16).toString("hex");
const SERVICE_LOCK_NAME = ".archive-service.lock";

let sinceLastPrune = 0;
let serviceLeaseDirectory: string | null = null;
let serviceLeaseOwner: string | null = null;
let serviceLeaseReleased = false;

// Archive operations return an explicit failure when the filesystem is
// unavailable. The paid route uses that signal before settlement so it never
// delivers a report that cannot later be recovered.
let unusable: string | null = null;
let configuredDirectory: string | null = null;
function dir(): string | null {
  const d = configuredDir();
  // A previous directory may have failed (for example a deliberate degraded
  // storage test). Changing ARCHIVE_DIR is an explicit reconfiguration and
  // must not poison the new location for the rest of the process lifetime.
  if (configuredDirectory !== d) {
    releaseServiceLease();
    configuredDirectory = d;
    unusable = null;
  }
  if (unusable === d) return null;
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  } catch {
    unusable = d;
    return null;
  }
}

function serviceLeasePath(d: string): string {
  return join(d, SERVICE_LOCK_NAME);
}

function ensureServiceLease(d: string): boolean {
  if (serviceLeaseDirectory === d && !serviceLeaseReleased) return true;
  // Migration ownership is the startup interlock. A service cannot start in
  // the gap after systemd was checked but before backup/apply takes its locks.
  if (existsSync(join(d, ".archive-migration.lock"))) return false;
  const lease = serviceLeasePath(d);
  const owner = join(lease, `${process.pid}-${PROCESS_LOCK_TOKEN}`);
  let createdLease = false;
  try {
    mkdirSync(lease, { mode: 0o700 });
    createdLease = true;
    writeFileSync(
      owner,
      JSON.stringify({
        pid: process.pid,
        startedAt: PROCESS_STARTED_AT,
        token: PROCESS_LOCK_TOKEN,
        purpose: "dossier-service",
      }),
      { flag: "wx", mode: 0o600 },
    );
    if (existsSync(join(d, ".archive-migration.lock"))) {
      unlinkSync(owner);
      try { rmdirSync(lease); } catch { /* another service process owns a lease */ }
      return false;
    }
    serviceLeaseDirectory = d;
    serviceLeaseOwner = owner;
    serviceLeaseReleased = false;
    return true;
  } catch {
    if (createdLease) {
      try { if (existsSync(owner)) unlinkSync(owner); } catch { /* preserve failure */ }
      try { rmdirSync(lease); } catch { /* preserve another process's lease */ }
    }
    return false;
  }
}

/** Acquire the standalone service lease before the HTTP app is imported. */
export function acquireServiceLeaseForServer(): boolean {
  const d = configuredDir();
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    if (configuredDirectory !== d) releaseServiceLease();
    configuredDirectory = d;
    unusable = null;
    return ensureServiceLease(d);
  } catch {
    unusable = d;
    return false;
  }
}

function releaseServiceLease(): void {
  if (!serviceLeaseDirectory || !serviceLeaseOwner || serviceLeaseReleased) return;
  const lease = serviceLeasePath(serviceLeaseDirectory);
  try {
    unlinkSync(serviceLeaseOwner);
    try { rmdirSync(lease); } catch { /* another service process owns a lease */ }
    syncDirectory(serviceLeaseDirectory);
  } catch {
    /* an unresolved lease remains a visible migration blocker */
  }
  serviceLeaseReleased = true;
  serviceLeaseOwner = null;
}

/**
 * A recovery code and the hash to file against it.
 *
 * 128 bits from the system CSPRNG. The code is returned to the caller so it can
 * be handed to the buyer; only the hash is ever written to disk, so an attacker
 * who reads the archive still cannot recover anything with it.
 */
export function newRecoveryCode(): { code: string; hash: string } {
  const code = randomBytes(16).toString("hex");
  return { code, hash: createHash("sha256").update(code).digest("hex") };
}

/** Constant-time check of a supplied code against a stored hash. */
export function recoveryCodeMatches(rec: ArchiveRecord, given: string): boolean {
  if (!rec.recoveryCodeSha256) return false;
  const a = Buffer.from(createHash("sha256").update(given).digest("hex"));
  const b = Buffer.from(rec.recoveryCodeSha256);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newId(): string {
  return randomUUID();
}

/**
 * Hash of the semantic request: the token and chain that were analysed.
 * `format` is excluded on purpose — a buyer proving ownership by resending
 * their original body should match whether or not they included it, and it
 * does not change which token was examined.
 */
export function paramsHash(params: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(params).sort()) {
    if (k === "format") continue;
    const v = params[k];
    if (v !== undefined && v !== null && v !== "") canonical[k] = String(v).toLowerCase();
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Filenames are ours to choose, but never trust one that came from a caller. */
function file(id: string): string | null {
  const d = dir();
  if (!d) return null;
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) return null;
  return join(d, id + ".json");
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeSyncedTemp(path: string, body: string): string {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return tmp;
  } catch (e) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original write error */ }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* preserve the original write error */
    }
    throw e;
  }
}

function atomicCreate(path: string, body: string): void {
  const tmp = writeSyncedTemp(path, body);
  try {
    // Hard-link publication is create-only and atomic on one filesystem. It
    // avoids the overwrite semantics of rename(): two processes can stage the
    // same id, but exactly one may publish it.
    linkSync(tmp, path);
    unlinkSync(tmp);
    syncDirectory(join(path, ".."));
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* preserve the original publication error */
    }
    throw e;
  }
}

function atomicReplace(path: string, body: string): void {
  const tmp = writeSyncedTemp(path, body);
  try {
    renameSync(tmp, path);
    syncDirectory(join(path, ".."));
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* preserve the original replacement error */
    }
    throw e;
  }
}

function transactionClaimFile(tx: string): string | null {
  const d = dir();
  if (!d || !validTransactionHash(tx)) return null;
  // Keep claims as non-JSON sidecars in the archive root. This preserves the
  // archive's existing record/prune/count semantics and lets operators inspect
  // one ownership proof without a second directory lifecycle.
  return join(d, `.tx-${transactionKey(tx)}.claim`);
}

function recordLockDir(id: string): string | null {
  const d = dir();
  if (!d || !/^[a-f0-9-]{8,64}$/i.test(id)) return null;
  return join(d, `.record-${id.toLowerCase()}.lock`);
}

function archiveLockDir(): string | null {
  const d = dir();
  return d ? join(d, ".archive.lock") : null;
}

function transactionLockDir(tx: string): string | null {
  const d = dir();
  if (!d || !validTransactionHash(tx)) return null;
  return join(d, `.transaction-${transactionKey(tx)}.lock`);
}

function jobLockDir(jobId: string): string | null {
  const d = dir();
  if (!d || !/^0x[a-f0-9]{64}$/i.test(jobId)) return null;
  return join(d, `.job-${jobId.toLowerCase()}.lock`);
}

interface LockOwner {
  pid: number;
  startedAt: number;
  token: string;
}

function lockOwnerPath(lock: string): string {
  return join(lock, "owner");
}

function readLockOwner(lock: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockOwnerPath(lock), "utf8")) as Partial<LockOwner>;
    if (
      !Number.isInteger(parsed.pid) ||
      !Number.isFinite(parsed.startedAt) ||
      typeof parsed.token !== "string" ||
      parsed.token.length < 16
    ) {
      return null;
    }
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

function lockOwnerSame(a: LockOwner | null, b: LockOwner | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.pid === b.pid &&
    a.startedAt === b.startedAt &&
    a.token === b.token
  );
}

function lockMtime(lock: string): number {
  try {
    return statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}

function processIsAlive(owner: LockOwner): boolean {
  if (owner.pid === process.pid) return owner.startedAt === PROCESS_STARTED_AT;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but this worker cannot signal it.
    return e?.code === "EPERM";
  }
}

function reclaimStaleLock(lock: string): boolean {
  const observedOwner = readLockOwner(lock);
  const observedMtime = lockMtime(lock);
  if (
    Date.now() - observedMtime < LOCK_STALE_MS ||
    (observedOwner && processIsAlive(observedOwner))
  ) {
    return false;
  }
  const tombstone = `${lock}.reclaim-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    // Rename is atomic within the archive filesystem. It prevents a second
    // worker from deleting a lock that was replaced between our stat and rm.
    renameSync(lock, tombstone);
    const movedOwner = readLockOwner(tombstone);
    const movedMtime = lockMtime(tombstone);
    const sameGeneration = observedOwner
      ? lockOwnerSame(observedOwner, movedOwner)
      : movedOwner === null && movedMtime === observedMtime;
    if (
      !sameGeneration ||
      Date.now() - movedMtime < LOCK_STALE_MS ||
      (movedOwner && processIsAlive(movedOwner))
    ) {
      try {
        renameSync(tombstone, lock);
      } catch {
        /* never delete a lock that did not match the stale generation */
      }
      return false;
    }
    try {
      unlinkSync(lockOwnerPath(tombstone));
    } catch {
      /* owner may never have been published */
    }
    rmdirSync(tombstone);
    syncDirectory(join(lock, ".."));
    return true;
  } catch {
    try { rmdirSync(tombstone); } catch { /* another worker may own cleanup */ }
    return false;
  }
}

function acquireLock(lock: string): boolean {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(
          lockOwnerPath(lock),
          JSON.stringify({
            pid: process.pid,
            startedAt: PROCESS_STARTED_AT,
            token: PROCESS_LOCK_TOKEN,
          }),
          { mode: 0o600, flag: "wx" },
        );
      } catch {
        try { rmdirSync(lock); } catch { /* preserve acquisition failure */ }
        throw new Error("lock owner publication failed");
      }
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST" || Date.now() >= deadline) return false;
      if (reclaimStaleLock(lock)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function releaseLock(lock: string): void {
  try {
    const owner = readLockOwner(lock);
    if (!owner || owner.pid !== process.pid || owner.startedAt !== PROCESS_STARTED_AT || owner.token !== PROCESS_LOCK_TOKEN) {
      return;
    }
    try {
      unlinkSync(lockOwnerPath(lock));
    } catch {
      return;
    }
    try {
      rmdirSync(lock);
      syncDirectory(join(lock, ".."));
    } catch {
      /* a failed cleanup remains visible and will be reclaimed after its TTL */
    }
  } catch {
    /* lock cleanup must never override a successful archive operation */
  }
}

function withLock<T>(lock: string | null, fn: () => T): T | null {
  if (!lock || !acquireLock(lock)) return null;
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

function withRecordLock<T>(id: string, fn: () => T): T | null {
  return withLock(recordLockDir(id), fn);
}

/**
 * Coordinate replay-hold publication with every destructive record cleanup.
 * The callback runs while the same cross-process lock used by discard/prune is
 * held, so either pruning wins and attachment sees no record, or attachment
 * publishes its hold first and pruning must preserve the record.
 */
export function withRetentionLock<T>(id: string, fn: () => T): T | null {
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) return null;
  return withRecordLock(id, fn);
}

function withArchiveLock<T>(fn: () => T): T | null {
  return withLock(archiveLockDir(), fn);
}

function withTransactionLock<T>(tx: string, fn: () => T): T | null {
  return withLock(transactionLockDir(tx), fn);
}

function withJobLock<T>(jobId: string, fn: () => T): T | null {
  return withLock(jobLockDir(jobId), fn);
}

function claimMacOf(claim: Omit<TransactionClaim, "mac">): string | undefined {
  return transactionClaimMac(claim, process.env.ARCHIVE_MAC_KEY) ?? undefined;
}

function claimValid(claim: TransactionClaim): boolean {
  return transactionClaimValid(
    claim,
    process.env.ARCHIVE_MAC_KEY,
    Boolean(process.env.ARCHIVE_MAC_KEY) || macRequired(),
  );
}

function readClaim(tx: string): { claim: TransactionClaim | null; invalid: boolean } {
  const p = transactionClaimFile(tx);
  if (!p || !existsSync(p)) return { claim: null, invalid: false };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as TransactionClaim;
    if (!claimValid(parsed) || parsed.transaction.toLowerCase() !== tx.toLowerCase()) {
      return { claim: null, invalid: true };
    }
    return { claim: parsed, invalid: false };
  } catch {
    return { claim: null, invalid: true };
  }
}

function recordHasClaim(id: string): boolean {
  const d = dir();
  if (!d) return true;
  try {
    for (const name of readdirSync(d)) {
      if (!name.startsWith(".tx-") || !name.endsWith(".claim")) continue;
      try {
        const claim = JSON.parse(readFileSync(join(d, name), "utf8")) as TransactionClaim;
        if (claim.recordId === id) return true;
      } catch {
        return true; // malformed ownership data makes destructive cleanup unsafe
      }
    }
  } catch {
    return true;
  }
  return false;
}

function recordHasReplayHold(id: string): boolean {
  const d = dir();
  if (!d) return true;
  try {
    return existsSync(join(d, `.report-${id.toLowerCase()}.replay-hold`));
  } catch {
    // Destructive cleanup fails closed if retention state cannot be read.
    return true;
  }
}

/** Conservative ownership check used only before deleting an orphan replay hold. */
function reportOwnership(id: string): "unowned" | "owned" | "unavailable" {
  const owner = byId(id);
  if (!owner || owner.id !== id) return "unavailable";
  return (
    owner.paymentTransaction ||
      owner.settlement ||
      owner.jobId ||
      recordHasClaim(id)
  )
    ? "owned"
    : "unowned";
}

function transactionOwnersOnDisk(
  tx: string,
): { owner: ArchiveRecord | null; ambiguous: boolean; unavailable: boolean } {
  const d = dir();
  if (!d) return { owner: null, ambiguous: false, unavailable: true };
  if (!index) index = buildIndex();
  const want = tx.toLowerCase();
  if (index.txAmbiguous.has(want)) {
    return { owner: null, ambiguous: true, unavailable: false };
  }
  const name = index.tx.get(want);
  if (!name) return { owner: null, ambiguous: false, unavailable: false };
  const owner = readByName(name);
  if (!owner) return { owner: null, ambiguous: false, unavailable: false };
  const candidate = owner.settlement?.transaction || owner.paymentTransaction;
  if (candidate?.toLowerCase() !== want) {
    // A stale index entry is rebuilt once; never fall back to a directory scan
    // per request, which would recreate the unauthenticated O(n) amplification
    // path this index exists to prevent.
    index = buildIndex();
    const refreshed = index.txAmbiguous.has(want)
      ? null
      : readByName(index.tx.get(want) ?? "");
    if (!refreshed) return { owner: null, ambiguous: index.txAmbiguous.has(want), unavailable: false };
    return { owner: refreshed, ambiguous: false, unavailable: false };
  }
  return { owner, ambiguous: false, unavailable: false };
}

/**
 * Authentication for an archive record, keyed by a secret held outside the
 * archive directory.
 *
 * Every record on disk was trusted because the file mode said 0600. That is a
 * statement about who may write, not about what was written: anything that can
 * write into ARCHIVE_DIR could repoint a settlement transaction at a different
 * report, swap the delivered bytes, or fabricate a record wholesale, and
 * recovery would serve the result as the document that buyer paid for. The
 * report's own attestation does not help, because it says nothing about which
 * transaction or job the report belongs to.
 *
 * The MAC covers exactly the fields that decide identity and content. It is
 * verified on every read, and a record that fails is treated as absent rather
 * than served with a warning.
 *
 * ARCHIVE_MAC_KEY is deliberately independent from the report SIGNING_KEY:
 * rotating an attestation key must not make paid recovery records unreadable.
 * With no archive key, records remain unauthenticated for legacy compatibility.
 * ARCHIVE_MAC_REQUIRED=1 is the post-migration mode and rejects unsigned files.
 */
function macRequired(): boolean {
  return process.env.ARCHIVE_MAC_REQUIRED === "1";
}

function macModeValid(): boolean {
  const value = process.env.ARCHIVE_MAC_REQUIRED;
  return value === undefined || value === "" || value === "0" || value === "1";
}

function legacyRequestKeyedRecord(value: unknown, name: string): boolean {
  if (!/^[a-f0-9]{64}\.json$/i.test(name) || !value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.id === undefined &&
    typeof record.paramsSha256 === "string" &&
    `${record.paramsSha256}.json`.toLowerCase() === name.toLowerCase() &&
    record.request !== null &&
    typeof record.request === "object" &&
    !Array.isArray(record.request) &&
    typeof record.contentType === "string" &&
    typeof record.deliverable === "string" &&
    typeof record.deliveredAt === "string" &&
    Number.isFinite(Date.parse(record.deliveredAt))
  );
}

function macOf(rec: ArchiveRecord): string | undefined {
  return archiveRecordMac(rec, process.env.ARCHIVE_MAC_KEY) ?? undefined;
}

/**
 * In migration mode a configured key signs new records and verifies any MAC
 * that is present, while unsigned legacy records remain readable. Strict mode
 * (`ARCHIVE_MAC_REQUIRED=1`) accepts only authenticated records and requires a
 * configured key. This compatibility window is intentionally explicit: it
 * does not turn old unsigned bytes into authenticated data.
 */
export function macValid(rec: ArchiveRecord): boolean {
  return archiveRecordMacValid(rec, process.env.ARCHIVE_MAC_KEY, macRequired());
}

function transactionMetadataValid(rec: ArchiveRecord): boolean {
  // Historical placeholders stay readable as inert metadata, but surrounding
  // whitespace is never canonical: HTTP recovery trims its input, so accepting
  // padded stored bytes would give one transaction two archive identities.
  if (
    rec.paymentTransaction !== undefined &&
    (typeof rec.paymentTransaction !== "string" ||
      rec.paymentTransaction === "" ||
      rec.paymentTransaction.trim() !== rec.paymentTransaction)
  ) {
    return false;
  }
  return (
    rec.settlement === undefined ||
    validConfirmedSettlement(rec.settlement, rec.paymentTransaction)
  );
}

function saveUnlocked(rec: ArchiveRecord): boolean {
  const f = file(rec.id);
  if (
    !f ||
    !transactionMetadataValid(rec) ||
    (macRequired() && !process.env.ARCHIVE_MAC_KEY)
  ) {
    return false;
  }
  try {
    const stamped: ArchiveRecord = { ...rec, mac: macOf(rec) };
    atomicCreate(f, JSON.stringify(stamped));
    // Keep a live index current rather than discarding it: a delivery saved
    // after the index was built must still be recoverable immediately.
    if (index && rec.jobId) setJob(index, rec.jobId, rec, rec.id + ".json");
    if (++sinceLastPrune >= PRUNE_EVERY) {
      sinceLastPrune = 0;
      prune();
    }
    return true;
  } catch {
    return false;
  }
}

export function save(rec: ArchiveRecord): boolean {
  if (!rec.jobId) return saveUnlocked(rec);
  const result = withJobLock(rec.jobId, () => saveUnlocked(rec));
  return result ?? false;
}

export type ArchiveReadiness = {
  ready: boolean;
  mode: "unsigned" | "migration" | "strict" | "invalid";
  unsignedRecords: number;
  reason?: string;
};

/**
 * Opaque, constant-cost version of the durability boundary. Directory entry
 * changes cover record, claim, replay-state, and replay-hold publication —
 * including writes from another process — while the configuration bits make
 * an environment transition invalidate the same cache. In-place corruption is
 * still caught by the cache's bounded periodic full scan.
 */
export function readinessVersion(): string | null {
  const d = dir();
  if (!d) return null;
  try {
    const mtimeNs = statSync(d, { bigint: true }).mtimeNs.toString();
    return createHash("sha256")
      .update(
        JSON.stringify({
          directory: d,
          mtimeNs,
          macRequired: process.env.ARCHIVE_MAC_REQUIRED ?? "",
          macConfigured: Boolean(process.env.ARCHIVE_MAC_KEY),
          replayConfigured: Boolean(process.env.PAYMENT_REPLAY_KEY),
        }),
      )
      .digest("hex");
  } catch {
    return null;
  }
}

/** Test seam for exercising cache invalidation without exposing archive paths. */
export function readinessVersionForTests(): string | null {
  return readinessVersion();
}

function inspectExistingArchive(d: string): ArchiveReadiness {
  if (!macModeValid()) {
    return {
      ready: false,
      mode: "invalid",
      unsignedRecords: 0,
      reason: "ARCHIVE_MAC_REQUIRED must be 0, 1, or unset",
    };
  }
  const key = Boolean(process.env.ARCHIVE_MAC_KEY);
  const strict = macRequired();
  const mode: ArchiveReadiness["mode"] = strict
    ? "strict"
    : key
      ? "migration"
      : "unsigned";
  try {
    const archiveMode = statSync(d).mode & 0o777;
    if ((archiveMode & 0o077) !== 0) {
      return {
        ready: false,
        mode,
        unsignedRecords: 0,
        reason: "archive directory must not be group- or world-accessible",
      };
    }
  } catch {
    return {
      ready: false,
      mode,
      unsignedRecords: 0,
      reason: "archive directory metadata unavailable",
    };
  }
  if (strict && !key) {
    return {
      ready: false,
      mode,
      unsignedRecords: 0,
      reason: "strict archive authentication requires ARCHIVE_MAC_KEY",
    };
  }

  let unsignedRecords = 0;
  const transactions = new Map<string, string>();
  const records = new Map<string, ArchiveRecord>();
  const claims: { name: string; claim: TransactionClaim }[] = [];
  const replayHolds: { name: string; hold: unknown }[] = [];
  try {
    for (const name of readdirSync(d)) {
      if (name.endsWith(".json") && !name.startsWith(".")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(join(d, name), "utf8"));
        } catch {
          return { ready: false, mode, unsignedRecords, reason: `malformed record: ${name}` };
        }
        // Request-keyed v1 files predate per-delivery ids. They remain readable
        // during migration, but strict readiness is impossible until the
        // approved migration has moved them to the authenticated cold archive.
        // Merely ignoring them here would let an operator enable paid traffic
        // before completing that required disposition.
        if (legacyRequestKeyedRecord(parsed, name)) {
          if (strict) {
            return {
              ready: false,
              mode,
              unsignedRecords,
              reason: `legacy request-keyed record requires cold-archive migration: ${name}`,
            };
          }
          continue;
        }
        const rec = parsed as ArchiveRecord;
        if (`${rec.id}.json` !== name || !/^[a-f0-9-]{8,64}$/i.test(rec.id)) {
          return { ready: false, mode, unsignedRecords, reason: `record id/filename mismatch: ${name}` };
        }
        if (!rec.request || typeof rec.request !== "object" || Array.isArray(rec.request)) {
          return { ready: false, mode, unsignedRecords, reason: `invalid request in record: ${name}` };
        }
        if (
          !/^[a-f0-9]{64}$/i.test(rec.paramsSha256) ||
          (rec.resolvedParamsSha256 !== undefined &&
            !/^[a-f0-9]{64}$/i.test(rec.resolvedParamsSha256)) ||
          typeof rec.contentType !== "string" ||
          typeof rec.deliverable !== "string" ||
          typeof rec.deliveredAt !== "string" ||
          !Number.isFinite(Date.parse(rec.deliveredAt))
        ) {
          return { ready: false, mode, unsignedRecords, reason: `invalid record shape: ${name}` };
        }
        if (!transactionMetadataValid(rec)) {
          return { ready: false, mode, unsignedRecords, reason: `invalid settlement in record: ${name}` };
        }
        if (!rec.mac) unsignedRecords++;
        if (key && rec.mac && !macValid(rec)) {
          return { ready: false, mode, unsignedRecords, reason: `record authentication failed: ${name}` };
        }
        if (strict && !rec.mac) {
          return { ready: false, mode, unsignedRecords, reason: `unsigned record in strict mode: ${name}` };
        }
        const tx = rec.settlement?.transaction || rec.paymentTransaction;
        if (tx) {
          // Historical test/import records contain placeholder strings such as
          // `0xtx123`. Preserve them under the record MAC, but never let them
          // participate in current payment ownership or make strict readiness
          // fail. Only canonical chain transaction hashes are recovery proofs.
          if (!validTransactionHash(tx)) {
            records.set(rec.id, rec);
            continue;
          }
          const normalized = tx.toLowerCase();
          const existing = transactions.get(normalized);
          if (existing && existing !== rec.id) {
            return {
              ready: false,
              mode,
              unsignedRecords,
              reason: `ambiguous transaction ownership: ${transactionKey(tx)}`,
            };
          }
          transactions.set(normalized, rec.id);
        }
        records.set(rec.id, rec);
        continue;
      }
      if (name.startsWith(".tx-") && name.endsWith(".claim")) {
        let claim: TransactionClaim;
        try {
          claim = JSON.parse(readFileSync(join(d, name), "utf8")) as TransactionClaim;
        } catch {
          return { ready: false, mode, unsignedRecords, reason: `malformed claim: ${name}` };
        }
        if (!claimValid(claim)) {
          return { ready: false, mode, unsignedRecords, reason: `invalid claim: ${name}` };
        }
        claims.push({ name, claim });
        continue;
      }
      if (name.startsWith(".report-") && name.endsWith(".replay-hold")) {
        let hold: unknown;
        try {
          hold = JSON.parse(readFileSync(join(d, name), "utf8"));
        } catch {
          return { ready: false, mode, unsignedRecords, reason: `malformed replay hold: ${name}` };
        }
        // Directory enumeration order is unspecified. Validate the owner only
        // after every report has been collected, just as transaction claims are
        // checked below; otherwise a hold that sorts before its report can make
        // a healthy archive fail readiness nondeterministically.
        replayHolds.push({ name, hold });
      }
    }
    for (const { name, hold } of replayHolds) {
      const inspected = inspectHold(hold);
      if (!inspected) {
        return { ready: false, mode, unsignedRecords, reason: `invalid replay hold: ${name}` };
      }
      const reportId = inspected.reportId;
      if (
        name !== `.report-${reportId.toLowerCase()}.replay-hold` ||
        !inspected.valid ||
        !records.has(reportId)
      ) {
        return { ready: false, mode, unsignedRecords, reason: `invalid replay hold: ${name}` };
      }
      const reconciled = reconcileHold(hold);
      if (
        reconciled.kind !== "valid" &&
        reconciled.kind !== "attached" &&
        reconciled.kind !== "removed"
      ) {
        return { ready: false, mode, unsignedRecords, reason: `invalid replay hold: ${name}` };
      }
    }
    for (const { name, claim } of claims) {
        const expectedName = `.tx-${transactionKey(claim.transaction)}.claim`;
        const owner = records.get(claim.recordId);
        if (name !== expectedName || !owner || !mergedClaimRecord(owner, claim)) {
          return { ready: false, mode, unsignedRecords, reason: `claim owner mismatch: ${name}` };
        }
        const normalized = claim.transaction.toLowerCase();
        const existing = transactions.get(normalized);
        if (existing && existing !== claim.recordId) {
          return {
            ready: false,
            mode,
            unsignedRecords,
            reason: `ambiguous transaction claim: ${transactionKey(claim.transaction)}`,
          };
        }
        transactions.set(normalized, claim.recordId);
    }
  } catch {
    return { ready: false, mode, unsignedRecords, reason: "archive scan failed" };
  }
  return { ready: true, mode, unsignedRecords };
}

/** Whether the archive can accept and recover trustworthy records right now. */
export function readiness(): ArchiveReadiness {
  const d = dir();
  if (!d) {
    return {
      ready: false,
      mode: macModeValid()
        ? macRequired()
          ? "strict"
          : process.env.ARCHIVE_MAC_KEY
            ? "migration"
            : "unsigned"
        : "invalid",
      unsignedRecords: 0,
      reason: "archive directory unavailable",
    };
  }
  const probe = join(d, `.ready-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(probe, "wx", 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    unlinkSync(probe);
    syncDirectory(d);
    return inspectExistingArchive(d);
  } catch {
    return {
      ready: false,
      mode: !macModeValid()
        ? "invalid"
        : macRequired()
          ? "strict"
          : process.env.ARCHIVE_MAC_KEY
            ? "migration"
            : "unsigned",
      unsignedRecords: 0,
      reason: "archive durability probe failed",
    };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* readiness remains false */ }
    }
    try {
      if (existsSync(probe)) unlinkSync(probe);
    } catch { /* a future readiness check will fail its durability probe */ }
  }
}

export function ready(): boolean {
  return readiness().ready;
}

/** Remove an undelivered orphan created before settlement was rejected. */
export function discard(id: string): boolean {
  const f = file(id);
  if (!f) return false;
  const result = withRecordLock(id, () => {
    try {
      if (!existsSync(f) || recordHasClaim(id) || recordHasReplayHold(id)) return false;
      const rec = JSON.parse(readFileSync(f, "utf8")) as ArchiveRecord;
      if (!macValid(rec) || rec.paymentTransaction || rec.settlement || rec.jobId) return false;
      unlinkSync(f);
      syncDirectory(join(f, ".."));
      index = null;
      return true;
    } catch {
      return false;
    }
  });
  return result ?? false;
}

/**
 * Mint a recovery code and file it against the report already delivered for
 * this job, rather than against a new record.
 *
 * The delivery message is fetched as a second call, after the report. Archiving
 * it as its own record made it the newest one for the job, so `byJobId` returned
 * the message instead of the document: a buyer who recovered got back the text
 * they were already holding. Verified on job 0xc4716819, which recovered 1095
 * bytes of message where the report should have been.
 *
 * Returns the code, or null when there is nothing to attach it to.
 */
export function attachRecoveryCode(jobId: string): string | null {
  try {
    const result = withJobLock(jobId, () => {
      // Select the owner only after taking the job lock. A concurrent delivery
      // may otherwise become the newest record between the lookup and the
      // record lock, attaching the returned code to the wrong report.
      const rec = byJobId(jobId);
      if (!rec) return null;
      const f = file(rec.id);
      if (!f || !existsSync(f)) return null;
      return withRecordLock(rec.id, () => {
      const { code, hash } = newRecoveryCode();
      const stored = JSON.parse(readFileSync(f, "utf8")) as ArchiveRecord;
      if (!macValid(stored) || stored.jobId?.toLowerCase() !== jobId.toLowerCase()) {
        return null;
      }
      stored.recoveryCodeSha256 = hash;
      // Covered by the MAC, so it has to be recomputed. Leaving it stale makes
      // the record fail authentication on the next read.
      stored.mac = macOf(stored);
      atomicReplace(f, JSON.stringify(stored));
      if (index) setJob(index, jobId, stored, stored.id + ".json");
      return code;
      });
    });
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * One atomic answer from transaction ownership. Returning the owner alongside
 * the status keeps the HTTP layer from doing a second lookup after the decision
 * (a cross-process TOCTOU gap).
 */
export type TransactionLinkResult =
  | { kind: "linked" | "already_linked"; owner: ArchiveRecord }
  | { kind: "transaction_conflict"; owner: ArchiveRecord }
  | {
      kind:
        | "record_missing"
        | "record_unauthenticated"
        | "record_conflict"
        | "claim_invalid"
        | "write_failed";
    };

function claimOwner(claim: TransactionClaim): ArchiveRecord | null {
  const owner = byId(claim.recordId);
  return owner ? mergedClaimRecord(owner, claim) : null;
}

/**
 * Recover confirmed ownership by report id, including the crash point where a
 * transaction claim was published but the convenience fields were not yet
 * merged back into the record. This is intentionally a bounded repair path for
 * an already-authenticated payment replay, not a public lookup surface.
 */
export function settledById(id: string): ArchiveRecord | null {
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) return null;
  const result = withArchiveLock(() => {
    const owner = byId(id);
    if (!owner) return null;
    if (owner.settlement?.status === "confirmed") return owner;
    const d = dir();
    if (!d) return null;
    let claimed: ArchiveRecord | null = null;
    try {
      for (const name of readdirSync(d)) {
        if (!name.startsWith(".tx-") || !name.endsWith(".claim")) continue;
        let parsed: TransactionClaim;
        try {
          parsed = JSON.parse(readFileSync(join(d, name), "utf8")) as TransactionClaim;
        } catch {
          return null;
        }
        if (parsed.recordId !== id) continue;
        if (!claimValid(parsed) || !parsed.settlement) return null;
        const merged = mergedClaimRecord(owner, parsed);
        if (!merged) return null;
        if (
          claimed &&
          claimed.settlement?.transaction.toLowerCase() !==
            merged.settlement?.transaction.toLowerCase()
        ) {
          return null;
        }
        claimed = merged;
      }
      return claimed;
    } catch {
      return null;
    }
  });
  return result ?? null;
}

function linkTransactionRecord(
  id: string,
  tx: string,
  settlement?: ArchiveRecord["settlement"],
): TransactionLinkResult {
  if (!validTransactionHash(tx)) return { kind: "record_conflict" };
  const f = file(id);
  if (!f) return { kind: "record_missing" };
  const claimPath = transactionClaimFile(tx);
  if (!claimPath) return { kind: "write_failed" };

  const result = withArchiveLock(() => withTransactionLock(tx, () => withRecordLock(id, (): TransactionLinkResult => {
    try {
      if (!existsSync(f)) return { kind: "record_missing" };
      const rec = JSON.parse(readFileSync(f, "utf8")) as ArchiveRecord;
      if (!macValid(rec)) return { kind: "record_unauthenticated" };

      const currentTx = rec.settlement?.transaction || rec.paymentTransaction;
      if (currentTx && currentTx.toLowerCase() !== tx.toLowerCase()) {
        return { kind: "record_conflict" };
      }
      if (rec.settlement && settlement && !settlementSame(rec.settlement, settlement)) {
        return { kind: "record_conflict" };
      }

      const existing = readClaim(tx);
      if (existing.invalid) return { kind: "claim_invalid" };
      if (existing.claim) {
        const existingClaim = existing.claim;
        const owner = claimOwner(existingClaim);
        if (!owner) return { kind: "claim_invalid" };
        if (existingClaim.recordId !== id) {
          if (settlement) {
            if (
              (existingClaim.settlement &&
                !settlementSame(existingClaim.settlement, settlement)) ||
              (owner.settlement && !settlementSame(owner.settlement, settlement))
            ) {
              return { kind: "record_conflict" };
            }
            if (!existingClaim.settlement) {
              const unsigned: Omit<TransactionClaim, "mac"> = {
                v: existingClaim.v,
                transaction: existingClaim.transaction,
                recordId: existingClaim.recordId,
                recordDigest: existingClaim.recordDigest,
                settlement,
              };
              const upgraded: TransactionClaim = {
                ...unsigned,
                mac: claimMacOf(unsigned),
              };
              try {
                atomicReplace(claimPath, JSON.stringify(upgraded));
              } catch {
                return { kind: "write_failed" };
              }
              const upgradedOwner = claimOwner(upgraded);
              if (!upgradedOwner) return { kind: "claim_invalid" };
              return { kind: "transaction_conflict", owner: upgradedOwner };
            }
          }
          return { kind: "transaction_conflict", owner };
        }
        if (
          existingClaim.recordDigest !== archiveRecordDigest(rec) ||
          (settlement &&
            existingClaim.settlement &&
            !settlementSame(existingClaim.settlement, settlement))
        ) {
          return { kind: "record_conflict" };
        }
        // A legacy link may have established ownership before the current
        // settlement metadata was introduced. Upgrade that claim in place so
        // callers can safely retry with the richer confirmed receipt.
        if (settlement && !existingClaim.settlement) {
          const unsigned: Omit<TransactionClaim, "mac"> = {
            v: existingClaim.v,
            transaction: existingClaim.transaction,
            recordId: existingClaim.recordId,
            recordDigest: existingClaim.recordDigest,
            settlement,
          };
          const upgraded: TransactionClaim = {
            ...unsigned,
            mac: claimMacOf(unsigned),
          };
          try {
            atomicReplace(claimPath, JSON.stringify(upgraded));
          } catch {
            return { kind: "write_failed" };
          }
          const upgradedOwner = claimOwner(upgraded);
          if (!upgradedOwner) return { kind: "claim_invalid" };
          return { kind: "already_linked", owner: upgradedOwner };
        }
        return { kind: "already_linked", owner };
      }

      // Before publishing a claim for a legacy archive, refuse an ambiguous
      // transaction rather than blessing whichever directory entry happened
      // to be scanned first. A unique legacy owner is converted to a claim.
      const legacy = transactionOwnersOnDisk(tx);
      if (legacy.unavailable) return { kind: "write_failed" };
      if (legacy.ambiguous) return { kind: "claim_invalid" };
      if (legacy.owner && legacy.owner.id !== id) {
        if (settlement && legacy.owner.settlement && !settlementSame(legacy.owner.settlement, settlement)) {
          return { kind: "record_conflict" };
        }
        const ownerRec = legacy.owner;
        const unsigned: Omit<TransactionClaim, "mac"> = {
          v: 1,
          transaction: tx,
          recordId: ownerRec.id,
          recordDigest: archiveRecordDigest(ownerRec),
          ...(settlement ? { settlement } : {}),
        };
        const claim: TransactionClaim = { ...unsigned, mac: claimMacOf(unsigned) };
        try {
          atomicCreate(claimPath, JSON.stringify(claim));
        } catch (e: any) {
          if (e?.code !== "EEXIST") return { kind: "write_failed" };
          const winner = readClaim(tx);
          if (winner.invalid || !winner.claim) return { kind: "claim_invalid" };
          const owner = claimOwner(winner.claim);
          if (!owner) return { kind: "claim_invalid" };
          return winner.claim.recordId === id
            ? { kind: "already_linked", owner }
            : { kind: "transaction_conflict", owner };
        }
        const claimedOwner = claimOwner(claim);
        return claimedOwner
          ? { kind: "transaction_conflict", owner: claimedOwner }
          : { kind: "claim_invalid" };
      }

      const ownerRec = legacy.owner ?? rec;
      const unsigned: Omit<TransactionClaim, "mac"> = {
        v: 1,
        transaction: tx,
        recordId: ownerRec.id,
        recordDigest: archiveRecordDigest(ownerRec),
        ...(settlement ? { settlement } : {}),
      };
      const claim: TransactionClaim = { ...unsigned, mac: claimMacOf(unsigned) };

      try {
        atomicCreate(claimPath, JSON.stringify(claim));
      } catch (e: any) {
        if (e?.code !== "EEXIST") return { kind: "write_failed" };
        const winner = readClaim(tx);
        if (winner.invalid || !winner.claim) return { kind: "claim_invalid" };
        const owner = claimOwner(winner.claim);
        if (!owner) return { kind: "claim_invalid" };
        return winner.claim.recordId === id
          ? { kind: "already_linked", owner }
          : { kind: "transaction_conflict", owner };
      }

      // The claim is the durable commit. Enriching the record improves direct
      // inspection and old tooling, but recovery can reconstruct from the claim
      // even if the process dies between publication and this replacement.
      const merged = mergedClaimRecord(rec, claim);
      if (!merged) return { kind: "record_conflict" };
      merged.mac = macOf(merged);
      try {
        atomicReplace(f, JSON.stringify(merged));
      } catch {
        // Claim + staged immutable report are already sufficient for recovery.
      }
      if (index) {
        const key = tx.toLowerCase();
        if (!index.txAmbiguous.has(key)) index.tx.set(key, id + ".json");
      }
      return { kind: "linked", owner: merged };
    } catch {
      return { kind: "write_failed" };
    }
  })));
  return result ?? { kind: "write_failed" };
}

/**
 * Link only a receipt that has already passed the payment-boundary validator.
 * The duplicate checks here are a second integrity boundary: a caller cannot
 * overwrite an existing report's transaction or assign one transaction to a
 * different report.
 */
export function linkConfirmedSettlement(
  id: string,
  settlement: NonNullable<ArchiveRecord["settlement"]>,
): TransactionLinkResult {
  if (
    settlement.status !== "confirmed" ||
    !validConfirmedSettlement(settlement)
  ) {
    return { kind: "record_conflict" };
  }
  return linkTransactionRecord(id, settlement.transaction, settlement);
}

/**
 * Compatibility helper for callers without explicit settlement metadata.
 * Ownership still requires an exact 32-byte on-chain transaction hash.
 */
export function linkTransaction(id: string, tx: string): TransactionLinkResult {
  // This helper omits explicit settlement metadata, but ownership still
  // requires the same exact on-chain transaction representation as the
  // confirmed-settlement path.
  return linkTransactionRecord(id, tx);
}

function readAll(): ArchiveRecord[] {
  const d = dir();
  if (!d) return [];
  const out: ArchiveRecord[] = [];
  try {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord;
        // Same rule as the keyed lookups: a record that fails authentication is
        // not a record. Enforcing it in one read path and not the other would
        // leave the second serving whatever was written into the directory.
        if (!macValid(rec) || !transactionMetadataValid(rec)) {
          console.error("[archive] record failed authentication, skipping it:", name);
          continue;
        }
        out.push(rec);
      } catch {
        /* skip unreadable record */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

// Proof -> filename indexes. Without them every recovery request parsed the
// whole archive: harmless at 17 records, but 289ms of CPU and 22MB of disk read
// per request once the archive reaches its 5000-record cap — which turns an
// unauthenticated free endpoint into an amplifier. Built once in a single scan,
// then maintained. Both proofs are indexed together because a directory walk is
// the expensive part; splitting them would double it.
interface Index {
  tx: Map<string, string>;
  txAmbiguous: Set<string>;
  job: Map<string, string>;
}
let index: Index | null = null;

/**
 * Point the job index at this delivery unless a newer one is already there.
 * A job can be delivered more than once — a re-run after a failed send — and
 * the buyer should get what was last sent to them, not the first attempt.
 */
function setJob(idx: Index, jobId: string, rec: ArchiveRecord, name: string): void {
  const key = jobId.toLowerCase();
  const cur = idx.job.get(key);
  if (cur && cur !== name) {
    const other = readByName(cur);
    if (other && other.deliveredAt > rec.deliveredAt) return;
  }
  idx.job.set(key, name);
}

function buildIndex(): Index {
  const idx: Index = { tx: new Map(), txAmbiguous: new Set(), job: new Map() };
  const d = dir();
  if (!d) return idx;
  // Chosen job records are held here during the walk so a duplicate job id is
  // resolved in memory rather than by re-reading the file it points at.
  const jobRec = new Map<string, ArchiveRecord>();
  try {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord;
        if (!macValid(rec) || !transactionMetadataValid(rec)) {
          console.error("[archive] record failed authentication, skipping index:", name);
          continue;
        }
        const tx = rec.settlement?.transaction || rec.paymentTransaction;
        if (tx && validTransactionHash(tx)) {
          const key = tx.toLowerCase();
          const current = idx.tx.get(key);
          if (current && current !== name) {
            idx.tx.delete(key);
            idx.txAmbiguous.add(key);
          } else if (!idx.txAmbiguous.has(key)) {
            idx.tx.set(key, name);
          }
        }
        if (rec.jobId) {
          const key = rec.jobId.toLowerCase();
          const cur = jobRec.get(key);
          if (!cur || rec.deliveredAt > cur.deliveredAt) {
            jobRec.set(key, rec);
            idx.job.set(key, name);
          }
        }
      } catch {
        /* skip unreadable record */
      }
    }
  } catch {
    /* ignore */
  }
  return idx;
}

function readByName(name: string): ArchiveRecord | null {
  const d = dir();
  if (!d) return null;
  try {
    const rec = JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord;
    // A record that fails its MAC is treated as absent, not served with a
    // caveat. Anything that could rewrite it could also rewrite a warning, and
    // handing back a document we cannot vouch for is the failure this guards.
    if (!macValid(rec) || !transactionMetadataValid(rec)) {
      console.error("[archive] record failed authentication, refusing to serve it:", name);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

/** Read one authenticated archive record by its server-issued id. */
export function byId(id: string): ArchiveRecord | null {
  const f = file(id);
  if (!f) return null;
  return readByName(id + ".json");
}

/**
 * Read a request-keyed record written before per-delivery archive ids existed.
 * These records cannot participate in current settlement claims or strict MAC
 * mode, but preserving this bounded compatibility lookup avoids making the
 * historical archive unreadable merely because current files use UUID names.
 */
function legacyByHash(hash: string): ArchiveRecord | null {
  const d = dir();
  if (!d || macRequired() || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  try {
    const value = JSON.parse(readFileSync(join(d, `${hash}.json`), "utf8")) as Partial<ArchiveRecord>;
    if (
      value.id !== undefined ||
      value.paramsSha256?.toLowerCase() !== hash.toLowerCase() ||
      !value.request ||
      typeof value.request !== "object" ||
      Array.isArray(value.request) ||
      typeof value.contentType !== "string" ||
      typeof value.deliverable !== "string" ||
      typeof value.deliveredAt !== "string"
    ) {
      return null;
    }
    return { ...value, id: hash } as ArchiveRecord;
  } catch {
    return null;
  }
}

configureArchiveAdapter({
  byId,
  settledById,
  byTransaction,
  reportOwnership,
  withRetentionLock,
});

function lookup(
  want: string,
  pick: (i: Index) => Map<string, string>,
  value: (r: ArchiveRecord) => string,
): ArchiveRecord | null {
  if (!index) index = buildIndex();
  // Trust the index only as far as the record confirms it; a stale entry must
  // never return the wrong buyer's report.
  const confirm = (name: string | undefined): ArchiveRecord | null => {
    if (!name) return null;
    const rec = readByName(name);
    return rec && value(rec).toLowerCase() === want ? rec : null;
  };
  const hit = pick(index).get(want);
  if (!hit) return null; // a miss stays O(1): rebuilding on misses is the amplifier
  return confirm(hit) ?? ((index = buildIndex()), confirm(pick(index).get(want)));
}

export function byTransaction(tx: string): ArchiveRecord | null {
  if (!validTransactionHash(tx)) return null;
  const claimed = readClaim(tx);
  if (claimed.invalid) {
    console.error("[archive] transaction claim failed authentication:", transactionKey(tx));
    return null;
  }
  if (claimed.claim) return claimOwner(claimed.claim);

  // Claims are authoritative for current writes. Legacy records predate them,
  // so a unique owner is still recoverable; duplicates are ambiguous and must
  // never become first/last-wins based on directory order.
  const legacy = transactionOwnersOnDisk(tx);
  if (legacy.unavailable) return null;
  if (legacy.ambiguous) {
    console.error("[archive] ambiguous legacy transaction ownership:", transactionKey(tx));
    return null;
  }
  if (legacy.owner) return legacy.owner;

  return lookup(
    tx.toLowerCase(),
    (i) => i.tx,
    (r) => r.settlement?.transaction || r.paymentTransaction || "",
  );
}

/** Recovery for a buyer who paid at the task level, where there is no tx. */
export function byJobId(jobId: string): ArchiveRecord | null {
  if (!/^0x[a-f0-9]{64}$/i.test(jobId)) return null;
  return lookup(
    jobId.toLowerCase(),
    (i) => i.job,
    (r) => r.jobId || "",
  );
}

/** Drop the cached index; used by tests and after bulk changes on disk. */
export function resetIndex(): void {
  index = null;
}

/**
 * Standalone server shutdown hook. The listener must stop accepting work and
 * drain in-flight requests before calling this; releasing earlier would let an
 * offline migration race a request that still has archive state in flight.
 */
export function releaseServiceLeaseAfterDrain(): void {
  releaseServiceLease();
}

/** Most recent delivery matching a semantic request hash. */
export function byHash(hash: string): ArchiveRecord | null {
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
  const matches = readAll()
    .filter((r) => r.paramsSha256 === hash)
    .sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : -1));
  return matches[0] ?? legacyByHash(hash);
}

function prune(): void {
  const d = dir();
  if (!d) return;
  withArchiveLock(() => {
    try {
    const now = Date.now();
    const files = readdirSync(d)
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => {
        const p = join(d, n);
        return { p, mtime: statSync(p).mtimeMs };
      });
    let removed = 0;
    const removeIfUnclaimed = (entry: { p: string }): boolean => {
      const id = entry.p.slice(entry.p.lastIndexOf("/") + 1, -5);
      const removedRecord = withRecordLock(id, () => {
        if (recordHasClaim(id) || recordHasReplayHold(id)) return false;
        try {
          // Migrated records can carry authoritative, MAC-covered settlement
          // ownership without a sidecar claim. Never prune any readable record
          // that already has transaction or job ownership: deleting it would
          // strand a paid buyer and leave the permanent replay/transaction
          // proof pointing at bytes that no longer exist. Unreadable or
          // unauthenticated bytes also fail closed instead of being destroyed.
          const stored = JSON.parse(readFileSync(entry.p, "utf8")) as ArchiveRecord;
          if (
            !macValid(stored) ||
            stored.id !== id ||
            stored.paymentTransaction ||
            stored.settlement ||
            stored.jobId
          ) {
            return false;
          }
          unlinkSync(entry.p);
          return true;
        } catch {
          return false;
        }
      });
      return removedRecord === true;
    };
    const survivors: typeof files = [];
    for (const f of files) {
      if (now - f.mtime > MAX_AGE_MS && removeIfUnclaimed(f)) {
        removed++;
      } else {
        survivors.push(f);
      }
    }
    let excess = survivors.length - MAX_RECORDS;
    for (const candidate of survivors.sort((a, b) => a.mtime - b.mtime)) {
      if (excess <= 0) break;
      if (removeIfUnclaimed(candidate)) {
        removed++;
        excess--;
      }
    }
    if (removed) {
      syncDirectory(d);
      index = null; // rebuilt on next lookup
    }
    } catch {
      /* ignore */
    }
  });
}
