import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";


export interface ReplayRequestIdentity {
  paramsSha256: string;
  contentType: "text/html" | "application/json" | "invalid";
}

export interface ReplayRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
}

export interface ReplaySettlement {
  transaction: string;
  network: string;
  amount?: string;
  payer?: string;
}

export interface ReplayHoldInspection {
  reportId: string;
  fingerprint: string;
  attemptToken: string;
  valid: boolean;
  stateMatches: boolean;
  stateStatus?: "pending" | "unknown" | "confirmed";
  stateReportId?: string;
}

export type ReplayHoldReconciliation =
  | { kind: "attached" | "removed" | "valid" }
  | { kind: "invalid" | "unavailable" };

interface ReplayArchiveAdapter {
  byId(reportId: string): unknown | null;
  settledById(reportId: string): unknown | null;
  byTransaction(transaction: string): unknown | null;
  reportOwnership(reportId: string): "unowned" | "owned" | "unavailable";
  withRetentionLock<T>(reportId: string, fn: () => T): T | null;
}

let archiveAdapter: ReplayArchiveAdapter | null = null;

export function configureArchiveAdapter(adapter: ReplayArchiveAdapter): void {
  archiveAdapter = adapter;
}

export type ReplayUnknownReason =
  | "settlement_unreachable"
  | "settlement_timeout"
  | "receipt_unconfirmed"
  | "archive_link_failed"
  | "replay_commit_failed";

export type ReplaySettlementEvidence = "candidate" | "confirmed";

interface ReplayState {
  v: 1;
  fingerprint: string;
  status: "pending" | "unknown" | "confirmed";
  attemptToken: string;
  request: ReplayRequestIdentity;
  requirements: ReplayRequirements;
  createdAt: string;
  updatedAt: string;
  ownerPid?: number;
  ownerStartedAt?: number;
  ownerToken?: string;
  reportId?: string;
  reason?: ReplayUnknownReason;
  settlement?: ReplaySettlement;
  /**
   * Candidate means a bounded timeout or pending response supplied this
   * identity but no final receipt/status has confirmed it. Confirmed means a
   * final receipt was validated and only the archive/replay commit remains to
   * be repaired.
   */
  settlementEvidence?: ReplaySettlementEvidence;
  mac?: string;
}

interface ReplayHold {
  v: 1;
  reportId: string;
  fingerprint: string;
  attemptToken: string;
  mac: string;
}

export type BeginReplayResult =
  | { kind: "created"; fingerprint: string; attemptToken: string }
  | { kind: "in_flight"; state: Readonly<ReplayState> }
  | { kind: "confirmed"; state: Readonly<ReplayState> }
  | { kind: "corrupt" | "unavailable" };

export type ReconcileReplayResult =
  | { kind: "not_found" | "corrupt" | "unavailable" }
  | { kind: "owned"; state: Readonly<ReplayState> };

export type ExistingReplayResult =
  | { kind: "not_found" | "corrupt" | "unavailable" }
  | { kind: "found"; state: Readonly<ReplayState> };

const LOCK_STALE_MS = 30_000;
// An unattached state means verification has begun but no report has been
// published yet. A live PID is not enough to keep it forever: a wedged process
// or a reused PID could otherwise strand that authorization permanently. Keep
// the window comfortably above the normal request/settlement timeout while
// still allowing a restart to recover without manual deletion.
const UNATTACHED_PENDING_STALE_MS = 30 * 60_000;
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);
const PROCESS_LOCK_TOKEN = randomBytes(16).toString("hex");
const UNKNOWN_REASONS = new Set<ReplayUnknownReason>([
  "settlement_unreachable",
  "settlement_timeout",
  "receipt_unconfirmed",
  "archive_link_failed",
  "replay_commit_failed",
]);

interface LockOwner {
  pid: number;
  startedAt: number;
  token: string;
}

function configuredDir(): string {
  return (
    process.env.ARCHIVE_DIR ||
    join(process.env.HOME || process.env.TMPDIR || "/tmp", ".dossier-archive")
  );
}

function replayKey(): Buffer | null {
  const key = process.env.PAYMENT_REPLAY_KEY || "";
  return key
    ? createHash("sha256").update(`dossier-payment-replay:${key}`).digest()
    : null;
}

export function ready(): boolean {
  if (!replayKey()) return false;
  const dir = directory();
  if (!dir) return false;
  const probe = join(
    dir,
    `.payment-ready-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(probe, "wx", 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    unlinkSync(probe);
    syncDirectory(dir);
    // Readiness is also a recovery-integrity check. A corrupt state or an
    // attached unsettled state whose retention hold vanished must disable paid
    // traffic before another payment can be accepted.
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(".payment-") || !name.endsWith(".state")) continue;
      const fingerprint = name.slice(".payment-".length, -".state".length);
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) return false;
      const current = readState(fingerprint);
      if (current.corrupt || !current.state) return false;
      const state = current.state;
      if (state.reportId && state.status !== "confirmed") {
        const path = holdPath(state.reportId);
        if (!path || !existsSync(path)) return false;
        try {
          const expected: Omit<ReplayHold, "mac"> = {
            v: 1,
            reportId: state.reportId,
            fingerprint,
            attemptToken: state.attemptToken,
          };
          if (!holdMatches(JSON.parse(readFileSync(path, "utf8")), expected)) {
            return false;
          }
        } catch {
          return false;
        }
      }
      if (state.status === "confirmed") {
        // A confirmed replay is itself a durable promise to return one exact
        // archived delivery without asking the facilitator to settle again.
        // Authenticate that promise against the archive's authoritative claim
        // on every readiness scan; otherwise a missing/tampered record or a
        // replay pointer rewritten to the wrong owner would leave paid traffic
        // enabled while retries can no longer be served safely.
        const owner = archiveAdapter?.byTransaction(state.settlement!.transaction);
        const value = owner && typeof owner === "object"
          ? owner as { id?: unknown; settlement?: unknown }
          : null;
        const settlement = value?.settlement && typeof value.settlement === "object"
          ? value.settlement as Record<string, unknown>
          : null;
        if (
          value?.id !== state.reportId ||
          settlement?.status !== "confirmed" ||
          typeof settlement.transaction !== "string" ||
          typeof settlement.network !== "string" ||
          !settlementSame(state.settlement!, {
            transaction: settlement.transaction,
            network: settlement.network,
            ...(typeof settlement.amount === "string"
              ? { amount: settlement.amount }
              : {}),
            ...(typeof settlement.payer === "string"
              ? { payer: settlement.payer }
              : {}),
          })
        ) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* readiness remains false */
      }
    }
    try {
      if (existsSync(probe)) unlinkSync(probe);
    } catch {
      /* readiness remains false */
    }
  }
}

function directory(): string | null {
  const path = configuredDir();
  try {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  } catch {
    return null;
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Replay identity is the authorization reconstructed and consumed by the
 * exact-EVM facilitator.  The x402 envelope is deliberately not part of that
 * identity: buyers may add inert transport fields (and buyer-only `extra`
 * keys) without changing the one-shot authorization they signed.
 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function canonicalUint(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value).toString(10);
  } catch {
    return null;
  }
}

function canonicalBytes32(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function canonicalEvmNetwork(value: unknown): string | null {
  if (typeof value !== "string" || !/^eip155:\d+$/.test(value)) return null;
  const chainId = canonicalUint(value.slice("eip155:".length));
  return chainId === null ? null : `eip155:${chainId}`;
}

function canonicalDomainString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function semanticAuthorizationIdentity(
  paymentPayload: unknown,
  requirements: unknown,
): Record<string, unknown> | null {
  const envelope = record(paymentPayload);
  const server = record(requirements);
  if (!envelope || !server || envelope.x402Version !== 2 || server.scheme !== "exact") {
    return null;
  }

  const network = canonicalEvmNetwork(server.network);
  const asset = canonicalAddress(server.asset);
  const payTo = canonicalAddress(server.payTo);
  const requiredAmount = canonicalUint(server.amount);
  const accepted = record(envelope.accepted);
  const rawPayload = record(envelope.payload);
  if (
    !network ||
    !asset ||
    !payTo ||
    requiredAmount === null ||
    !accepted ||
    accepted.scheme !== "exact" ||
    !rawPayload
  ) {
    return null;
  }

  const hasEip3009 = Object.prototype.hasOwnProperty.call(rawPayload, "authorization");
  const hasPermit2 = Object.prototype.hasOwnProperty.call(rawPayload, "permit2Authorization");
  if (hasEip3009 === hasPermit2 || typeof rawPayload.signature !== "string" || !rawPayload.signature) {
    return null;
  }

  if (hasEip3009) {
    const authorization = record(rawPayload.authorization);
    const extra = record(server.extra);
    const name = canonicalDomainString(extra?.name);
    const version = canonicalDomainString(extra?.version);
    if (!authorization || !name || !version) return null;
    const from = canonicalAddress(authorization.from);
    const to = canonicalAddress(authorization.to);
    const value = canonicalUint(authorization.value);
    const validAfter = canonicalUint(authorization.validAfter);
    const validBefore = canonicalUint(authorization.validBefore);
    const nonce = canonicalBytes32(authorization.nonce);
    if (!from || !to || value === null || validAfter === null || validBefore === null || !nonce) {
      return null;
    }
    if (to !== payTo || value !== requiredAmount) return null;
    return {
      v: 2,
      scheme: "exact",
      method: "eip3009",
      network,
      asset,
      domain: { name, version },
      authorization: { from, to, value, validAfter, validBefore, nonce },
    };
  }

  const authorization = record(rawPayload.permit2Authorization);
  const permitted = record(authorization?.permitted);
  const witness = record(authorization?.witness);
  if (!authorization || !permitted || !witness) return null;
  const from = canonicalAddress(authorization.from);
  const token = canonicalAddress(permitted.token);
  const amount = canonicalUint(permitted.amount);
  const spender = canonicalAddress(authorization.spender);
  const nonce = canonicalUint(authorization.nonce);
  const deadline = canonicalUint(authorization.deadline);
  const to = canonicalAddress(witness.to);
  const validAfter = canonicalUint(witness.validAfter);
  if (
    !from ||
    !token ||
    amount === null ||
    !spender ||
    nonce === null ||
    deadline === null ||
    !to ||
    validAfter === null
  ) {
    return null;
  }
  if (token !== asset || amount !== requiredAmount || to !== payTo) return null;
  return {
    v: 2,
    scheme: "exact",
    method: "permit2",
    network,
    asset,
    authorization: {
      from,
      permitted: { token, amount },
      spender,
      nonce,
      deadline,
      witness: { to, validAfter },
    },
  };
}

function stateMac(state: Omit<ReplayState, "mac">): string | null {
  const key = replayKey();
  if (!key) return null;
  return createHmac("sha256", key).update(canonicalValue(state)).digest("hex");
}

function validRequest(value: unknown): value is ReplayRequestIdentity {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.paramsSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(request.paramsSha256) &&
    (request.contentType === "text/html" ||
      request.contentType === "application/json" ||
      request.contentType === "invalid")
  );
}

function validRequirements(value: unknown): value is ReplayRequirements {
  if (!value || typeof value !== "object") return false;
  const requirements = value as Record<string, unknown>;
  return ["scheme", "network", "amount", "asset", "payTo"].every(
    (key) => typeof requirements[key] === "string" && requirements[key] !== "",
  );
}

function validSettlement(value: unknown): value is ReplaySettlement {
  if (!value || typeof value !== "object") return false;
  const settlement = value as Record<string, unknown>;
  return (
    typeof settlement.transaction === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) &&
    typeof settlement.network === "string" &&
    settlement.network !== "" &&
    (settlement.amount === undefined || typeof settlement.amount === "string") &&
    (settlement.payer === undefined ||
      (typeof settlement.payer === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(settlement.payer)))
  );
}

function validUnknownReason(value: unknown): value is ReplayUnknownReason {
  return typeof value === "string" && UNKNOWN_REASONS.has(value as ReplayUnknownReason);
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function validState(value: unknown, fingerprint: string): value is ReplayState {
  if (!value || typeof value !== "object") return false;
  const state = value as ReplayState;
  const createdAt = timestampMs(state.createdAt);
  const updatedAt = timestampMs(state.updatedAt);
  if (
    state.v !== 1 ||
    state.fingerprint !== fingerprint ||
    !["pending", "unknown", "confirmed"].includes(state.status) ||
    typeof state.attemptToken !== "string" ||
    !/^[a-f0-9]{32}$/.test(state.attemptToken) ||
    !validRequest(state.request) ||
    !validRequirements(state.requirements) ||
    createdAt === null ||
    updatedAt === null ||
    updatedAt < createdAt ||
    (state.ownerPid !== undefined && (!Number.isSafeInteger(state.ownerPid) || state.ownerPid < 1)) ||
    (state.ownerStartedAt !== undefined && (!Number.isSafeInteger(state.ownerStartedAt) || state.ownerStartedAt < 1)) ||
    (state.ownerToken !== undefined && (typeof state.ownerToken !== "string" || !/^[a-f0-9]{32}$/.test(state.ownerToken))) ||
    (state.reportId !== undefined &&
      (typeof state.reportId !== "string" ||
        !/^[a-f0-9-]{8,64}$/i.test(state.reportId))) ||
    typeof state.mac !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.mac)
  ) {
    return false;
  }
  if (state.status === "pending") {
    if (
      state.reason !== undefined ||
      state.settlement !== undefined ||
      state.settlementEvidence !== undefined
    ) {
      return false;
    }
    const ownerFields = [state.ownerPid, state.ownerStartedAt, state.ownerToken];
    if (ownerFields.some((value) => value !== undefined) && ownerFields.some((value) => value === undefined)) return false;
  } else if (state.status === "unknown") {
    if (state.ownerPid !== undefined || state.ownerStartedAt !== undefined || state.ownerToken !== undefined) return false;
    if (!validUnknownReason(state.reason)) return false;
    if (
      (state.reason === "settlement_unreachable" ||
        state.reason === "settlement_timeout" ||
        state.reason === "receipt_unconfirmed") &&
      !state.reportId
    ) {
      return false;
    }
    if (state.reason === "archive_link_failed" && !state.reportId) return false;
    if (
      state.reason === "replay_commit_failed" &&
      (!state.reportId || !validSettlement(state.settlement))
    ) {
      return false;
    }
    if (state.settlement !== undefined && !validSettlement(state.settlement)) return false;
    if (
      state.settlementEvidence !== undefined &&
      state.settlementEvidence !== "candidate" &&
      state.settlementEvidence !== "confirmed"
    ) {
      return false;
    }
    if (state.settlement === undefined && state.settlementEvidence !== undefined) return false;
    if (state.reason === "replay_commit_failed" || state.reason === "archive_link_failed") {
      if (state.settlement !== undefined && state.settlementEvidence !== "confirmed") return false;
    } else if (
      state.settlement !== undefined &&
      state.settlementEvidence !== "candidate"
    ) {
      return false;
    }
  } else {
    if (state.ownerPid !== undefined || state.ownerStartedAt !== undefined || state.ownerToken !== undefined) return false;
    if (
      state.reason !== undefined ||
      state.settlementEvidence !== undefined ||
      !state.reportId ||
      !validSettlement(state.settlement)
    ) {
      return false;
    }
  }
  const { mac, ...unsigned } = state;
  const expected = stateMac(unsigned);
  if (!expected) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(mac, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function statePath(fingerprint: string): string | null {
  const dir = directory();
  if (!dir || !/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  return join(dir, `.payment-${fingerprint}.state`);
}

function holdPath(reportId: string): string | null {
  const dir = directory();
  if (!dir || !/^[a-f0-9-]{8,64}$/i.test(reportId)) return null;
  return join(dir, `.report-${reportId.toLowerCase()}.replay-hold`);
}

function lockPath(fingerprint: string): string | null {
  const dir = directory();
  if (!dir || !/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  return join(dir, `.payment-${fingerprint}.lock`);
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
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return temp;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* preserve the original failure */
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* preserve the original failure */
    }
    throw error;
  }
}

function atomicCreate(path: string, body: string): void {
  const temp = writeSyncedTemp(path, body);
  try {
    linkSync(temp, path);
    unlinkSync(temp);
    syncDirectory(join(path, ".."));
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* preserve the original failure */
    }
    throw error;
  }
}

function atomicReplace(path: string, body: string): void {
  const temp = writeSyncedTemp(path, body);
  try {
    renameSync(temp, path);
    syncDirectory(join(path, ".."));
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* preserve the original failure */
    }
    throw error;
  }
}

function lockOwnerPath(lock: string): string {
  return join(lock, "owner");
}

function readLockOwner(lock: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(lockOwnerPath(lock), "utf8")) as LockOwner;
    return Number.isInteger(value.pid) &&
      Number.isFinite(value.startedAt) &&
      typeof value.token === "string"
      ? value
      : null;
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

function processAlive(owner: LockOwner): boolean {
  if (owner.pid === process.pid) return owner.startedAt === PROCESS_STARTED_AT;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function reclaimStaleLock(lock: string): boolean {
  try {
    const observedMtime = statSync(lock).mtimeMs;
    if (Date.now() - observedMtime < LOCK_STALE_MS) return false;
    const observedOwner = readLockOwner(lock);
    if (observedOwner && processAlive(observedOwner)) return false;
    const tombstone = `${lock}.reclaim-${process.pid}-${randomBytes(6).toString("hex")}`;
    renameSync(lock, tombstone);
    const movedMtime = statSync(tombstone).mtimeMs;
    const movedOwner = readLockOwner(tombstone);
    const sameGeneration = observedOwner
      ? lockOwnerSame(observedOwner, movedOwner)
      : movedOwner === null && movedMtime === observedMtime;
    if (
      !sameGeneration ||
      Date.now() - movedMtime < LOCK_STALE_MS ||
      (movedOwner && processAlive(movedOwner))
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
      /* owner may not have been published before a crash */
    }
    rmdirSync(tombstone);
    syncDirectory(join(lock, ".."));
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lock: string): boolean {
  const deadline = Date.now() + 5_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
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
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        try {
          rmdirSync(lock);
        } catch {
          /* preserve the publication failure */
        }
        throw error;
      }
      return true;
    } catch (error: any) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) return false;
      if (reclaimStaleLock(lock)) continue;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
}

function releaseLock(lock: string): void {
  try {
    const owner = readLockOwner(lock);
    if (
      !owner ||
      owner.pid !== process.pid ||
      owner.startedAt !== PROCESS_STARTED_AT ||
      owner.token !== PROCESS_LOCK_TOKEN
    ) {
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
      /* stale cleanup is recoverable and must not override the operation */
    }
  } catch {
    /* stale cleanup is recoverable and must not override the operation */
  }
}

function withReplayLock<T>(fingerprint: string, action: () => T): T | null {
  try {
    const lock = lockPath(fingerprint);
    if (!lock || !acquireLock(lock)) return null;
    try {
      return action();
    } finally {
      releaseLock(lock);
    }
  } catch {
    // Replay state is a recovery aid, never a reason for a request to throw
    // an opaque filesystem exception through the payment middleware. Callers
    // receive an explicit false/unavailable result and fail closed.
    return null;
  }
}

function stamp(state: Omit<ReplayState, "mac">): ReplayState | null {
  const mac = stateMac(state);
  return mac ? { ...state, mac } : null;
}

function stampHold(
  hold: Omit<ReplayHold, "mac">,
): ReplayHold | null {
  const key = replayKey();
  if (!key) return null;
  return {
    ...hold,
    mac: createHmac("sha256", key)
      .update(canonicalValue(hold))
      .digest("hex"),
  };
}

function holdMatches(
  value: unknown,
  expected: Omit<ReplayHold, "mac">,
): value is ReplayHold {
  if (!value || typeof value !== "object") return false;
  const hold = value as ReplayHold;
  if (
    hold.v !== 1 ||
    hold.reportId !== expected.reportId ||
    hold.fingerprint !== expected.fingerprint ||
    hold.attemptToken !== expected.attemptToken ||
    typeof hold.mac !== "string" ||
    !/^[a-f0-9]{64}$/.test(hold.mac)
  ) {
    return false;
  }
  const stamped = stampHold(expected);
  if (!stamped) return false;
  const a = Buffer.from(stamped.mac, "hex");
  const b = Buffer.from(hold.mac, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authenticate one report-indexed retention hold and its owning replay state. */
export function inspectHold(value: unknown): ReplayHoldInspection | null {
  if (!value || typeof value !== "object") return null;
  const hold = value as Partial<ReplayHold>;
  if (
    hold.v !== 1 ||
    typeof hold.reportId !== "string" ||
    !/^[a-f0-9-]{8,64}$/i.test(hold.reportId) ||
    typeof hold.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(hold.fingerprint) ||
    typeof hold.attemptToken !== "string" ||
    !/^[a-f0-9]{32}$/.test(hold.attemptToken)
  ) {
    return null;
  }
  const expected = {
    v: 1 as const,
    reportId: hold.reportId,
    fingerprint: hold.fingerprint,
    attemptToken: hold.attemptToken,
  };
  const valid = holdMatches(value, expected);
  const replay = valid ? readState(hold.fingerprint) : { state: null, corrupt: false };
  const stateMatches = Boolean(
    valid &&
      !replay.corrupt &&
      replay.state &&
      replay.state.attemptToken === hold.attemptToken &&
      replay.state.reportId === hold.reportId,
  );
  return {
    reportId: hold.reportId,
    fingerprint: hold.fingerprint,
    attemptToken: hold.attemptToken,
    valid,
    stateMatches,
    ...(replay.state ? { stateStatus: replay.state.status } : {}),
    ...(replay.state?.reportId ? { stateReportId: replay.state.reportId } : {}),
  };
}

/**
 * Repair only the two safe crash residues created by replay/hold publication.
 * The archive must call this while validating an authenticated hold whose
 * filename and referenced report already match. Lock order stays identical to
 * attach/release/prune: record first, then replay.
 */
export function reconcileHold(value: unknown): ReplayHoldReconciliation {
  const inspected = inspectHold(value);
  if (!inspected || !inspected.valid || !archiveAdapter) {
    return { kind: "invalid" };
  }
  const { reportId, fingerprint, attemptToken } = inspected;
  const path = statePath(fingerprint);
  if (!path) return { kind: "unavailable" };
  const adapter = archiveAdapter;

  try {
    const result = adapter.withRetentionLock(reportId, () =>
      withReplayLock<ReplayHoldReconciliation>(fingerprint, () => {
        const expected: Omit<ReplayHold, "mac"> = {
          v: 1,
          reportId,
          fingerprint,
          attemptToken,
        };
        const hold = holdPath(reportId);
        if (!hold || !existsSync(hold)) return { kind: "invalid" };
        try {
          if (!holdMatches(JSON.parse(readFileSync(hold, "utf8")), expected)) {
            return { kind: "invalid" };
          }
        } catch {
          return { kind: "invalid" };
        }

        const replay = readState(fingerprint);
        if (replay.corrupt) return { kind: "invalid" };
        if (!replay.state) {
          // release() deletes replay state before its hold. The sidecar may be
          // removed only while the report still has no transaction, job, or
          // claim ownership; uncertain ownership deliberately stays fail-closed.
          if (adapter.reportOwnership(reportId) !== "unowned") {
            return { kind: "invalid" };
          }
          return removeOwnedHold(reportId, fingerprint, attemptToken)
            ? { kind: "removed" }
            : { kind: "unavailable" };
        }

        const state = replay.state;
        if (state.attemptToken !== attemptToken) return { kind: "invalid" };
        if (state.status === "confirmed") {
          // A confirmed replay makes a hold redundant only after the archive
          // proves that the exact settlement is durably owned by the replay's
          // current report. This also covers the crash residue where conflict
          // adoption replaced state.reportId but died before unlinking the
          // losing candidate's report-indexed hold.
          const owner = adapter.byTransaction(state.settlement!.transaction);
          const value = owner && typeof owner === "object"
            ? owner as { id?: unknown; settlement?: unknown }
            : null;
          const settlement = value?.settlement && typeof value.settlement === "object"
            ? value.settlement as Record<string, unknown>
            : null;
          if (
            value?.id !== state.reportId ||
            settlement?.status !== "confirmed" ||
            typeof settlement.transaction !== "string" ||
            typeof settlement.network !== "string" ||
            !settlementSame(state.settlement!, {
              transaction: settlement.transaction,
              network: settlement.network,
              ...(typeof settlement.amount === "string"
                ? { amount: settlement.amount }
                : {}),
              ...(typeof settlement.payer === "string"
                ? { payer: settlement.payer }
                : {}),
            })
          ) {
            return { kind: "invalid" };
          }
          // A hold for the current owner is redundant. A hold for a
          // superseded candidate is also removable, but only when that
          // candidate has no durable payment/job/claim owner. Any ambiguity
          // remains fail-closed so an operator can reconcile it explicitly.
          if (state.reportId !== reportId && adapter.reportOwnership(reportId) !== "unowned") {
            return { kind: "invalid" };
          }
          return removeOwnedHold(reportId, fingerprint, attemptToken)
            ? { kind: "removed" }
            : { kind: "unavailable" };
        }

        if (state.reportId === reportId) return { kind: "valid" };

        // attachReport() publishes the hold before replacing state. Only the
        // exact still-pending, unattached owner can be repaired here.
        if (state.reportId !== undefined || state.status !== "pending") {
          return { kind: "invalid" };
        }
        const report = adapter.byId(reportId);
        if (
          !report ||
          typeof report !== "object" ||
          (report as { id?: unknown }).id !== reportId
        ) {
          return { kind: "invalid" };
        }
        const {
          mac: _mac,
          ownerPid: _ownerPid,
          ownerStartedAt: _ownerStartedAt,
          ownerToken: _ownerToken,
          ...unsigned
        } = state;
        const stamped = stamp({
          ...unsigned,
          reportId,
          updatedAt: new Date().toISOString(),
        });
        if (!stamped) return { kind: "unavailable" };
        try {
          atomicReplace(path, JSON.stringify(stamped));
          return { kind: "attached" };
        } catch {
          return { kind: "unavailable" };
        }
      }),
    );
    return result ?? { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

function ensureHold(
  reportId: string,
  fingerprint: string,
  attemptToken: string,
): boolean {
  const path = holdPath(reportId);
  if (!path) return false;
  const unsigned: Omit<ReplayHold, "mac"> = {
    v: 1,
    reportId,
    fingerprint,
    attemptToken,
  };
  const hold = stampHold(unsigned);
  if (!hold) return false;
  if (existsSync(path)) {
    try {
      return holdMatches(JSON.parse(readFileSync(path, "utf8")), unsigned);
    } catch {
      return false;
    }
  }
  try {
    atomicCreate(path, JSON.stringify(hold));
    return true;
  } catch (error: any) {
    if (error?.code !== "EEXIST") return false;
    try {
      return holdMatches(JSON.parse(readFileSync(path, "utf8")), unsigned);
    } catch {
      return false;
    }
  }
}

function removeOwnedHold(
  reportId: string,
  fingerprint: string,
  attemptToken: string,
): boolean {
  const path = holdPath(reportId);
  if (!path || !existsSync(path)) return true;
  const expected: Omit<ReplayHold, "mac"> = {
    v: 1,
    reportId,
    fingerprint,
    attemptToken,
  };
  try {
    const hold = JSON.parse(readFileSync(path, "utf8"));
    if (!holdMatches(hold, expected)) return false;
    unlinkSync(path);
    syncDirectory(join(path, ".."));
    return true;
  } catch {
    return false;
  }
}

function readState(fingerprint: string): { state: ReplayState | null; corrupt: boolean } {
  const path = statePath(fingerprint);
  if (!path || !existsSync(path)) return { state: null, corrupt: false };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return validState(value, fingerprint)
      ? { state: value, corrupt: false }
      : { state: null, corrupt: true };
  } catch {
    return { state: null, corrupt: true };
  }
}

/**
 * Authenticate one replay state without creating, replacing, locking, or
 * otherwise publishing anything in the archive directory.
 *
 * This is intentionally narrower than begin(): callers may use it to decide
 * whether an exact authorization is already durable, but a brand-new payment
 * must not gain trusted-retry status merely by asking the question.
 */
export function existing(fingerprint: string): ExistingReplayResult {
  try {
    if (!replayKey() || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      return { kind: "unavailable" };
    }
    const current = readState(fingerprint);
    if (current.corrupt) return { kind: "corrupt" };
    return current.state
      ? { kind: "found", state: current.state }
      : { kind: "not_found" };
  } catch {
    return { kind: "unavailable" };
  }
}

function pendingOwnerAlive(state: ReplayState): boolean {
  if (!state.ownerPid || state.ownerStartedAt === undefined || !state.ownerToken) return false;
  if (state.ownerPid === process.pid) {
    return state.ownerStartedAt === PROCESS_STARTED_AT && state.ownerToken === PROCESS_LOCK_TOKEN;
  }
  try {
    process.kill(state.ownerPid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function reclaimableUnattachedPending(state: ReplayState): boolean {
  if (state.status !== "pending" || state.reportId) return false;
  const updatedAt = timestampMs(state.updatedAt);
  if (updatedAt === null) return false;
  const stale = Date.now() - updatedAt >= UNATTACHED_PENDING_STALE_MS;
  // States written before process ownership was introduced have no owner to
  // probe. Give a fresh legacy request the same conservative completion window
  // instead of mistaking missing metadata for a definitively dead process.
  if (state.ownerPid === undefined) return stale;
  return !pendingOwnerAlive(state) || stale;
}

export function fingerprintPayment(
  paymentPayload: unknown,
  requirements: unknown,
): string | null {
  try {
    const key = replayKey();
    if (!key) return null;
    const identity = semanticAuthorizationIdentity(paymentPayload, requirements);
    if (!identity) return null;
    return createHmac("sha256", key)
      .update(canonicalValue(identity))
      .digest("hex");
  } catch {
    return null;
  }
}

export function reconciliationId(fingerprint: string): string | null {
  return /^[a-f0-9]{64}$/.test(fingerprint)
    ? `pay_${fingerprint.slice(0, 24)}`
    : null;
}

/** Read one authenticated state while holding its cross-process owner lock. */
export function reconcileState(
  fingerprint: string,
  attemptToken: string,
): ReconcileReplayResult {
  try {
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/^[a-f0-9]{32}$/.test(attemptToken)) {
      return { kind: "unavailable" };
    }
    const result = withReplayLock<ReconcileReplayResult>(fingerprint, () => {
      const current = readState(fingerprint);
      if (current.corrupt) return { kind: "corrupt" };
      if (!current.state) return { kind: "not_found" };
      if (current.state.attemptToken !== attemptToken) return { kind: "unavailable" };
      return { kind: "owned", state: current.state };
    });
    return result ?? { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export function begin(
  fingerprint: string,
  request: ReplayRequestIdentity,
  requirements: ReplayRequirements,
): BeginReplayResult {
  try {
    const path = statePath(fingerprint);
    if (
      !path ||
      !replayKey() ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !validRequest(request) ||
      !validRequirements(requirements)
    ) {
      return { kind: "unavailable" };
    }
    const result = withReplayLock<BeginReplayResult>(fingerprint, () => {
      const existing = readState(fingerprint);
      if (existing.corrupt) return { kind: "corrupt" };
      if (existing.state) {
        if (reclaimableUnattachedPending(existing.state)) {
          try {
            unlinkSync(path);
            syncDirectory(join(path, ".."));
          } catch {
            return { kind: "unavailable" };
          }
        } else {
          return existing.state.status === "confirmed"
            ? { kind: "confirmed", state: existing.state }
            : { kind: "in_flight", state: existing.state };
        }
      }
      const now = new Date().toISOString();
      const attemptToken = randomBytes(16).toString("hex");
      const state = stamp({
        v: 1,
        fingerprint,
        status: "pending",
        attemptToken,
        request,
        requirements,
        createdAt: now,
        updatedAt: now,
        ownerPid: process.pid,
        ownerStartedAt: PROCESS_STARTED_AT,
        ownerToken: PROCESS_LOCK_TOKEN,
      });
      if (!state) return { kind: "unavailable" };
      try {
        atomicCreate(path, JSON.stringify(state));
        return { kind: "created", fingerprint, attemptToken };
      } catch (error: any) {
        if (error?.code !== "EEXIST") return { kind: "unavailable" };
        const winner = readState(fingerprint);
        if (winner.corrupt || !winner.state) return { kind: "corrupt" };
        return winner.state.status === "confirmed"
          ? { kind: "confirmed", state: winner.state }
          : { kind: "in_flight", state: winner.state };
      }
    });
    return result ?? { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

function replaceOwned(
  fingerprint: string,
  attemptToken: string,
  update: (state: ReplayState) => Omit<ReplayState, "mac"> | null,
): boolean {
  const path = statePath(fingerprint);
  if (!path) return false;
  const result = withReplayLock(fingerprint, () => {
    const current = readState(fingerprint);
    if (current.corrupt || !current.state) return false;
    if (current.state.attemptToken !== attemptToken) return false;
    const next = update(current.state);
    if (!next) return false;
    const stamped = stamp(next);
    if (!stamped) return false;
    atomicReplace(path, JSON.stringify(stamped));
    return true;
  });
  return result === true;
}

export function attachReport(
  fingerprint: string,
  attemptToken: string,
  reportId: string,
): boolean {
  try {
    if (!/^[a-f0-9-]{8,64}$/i.test(reportId)) return false;
    const path = statePath(fingerprint);
    if (!path) return false;
    if (!archiveAdapter) return false;
    const result = archiveAdapter.withRetentionLock(
      reportId,
      () => withReplayLock(fingerprint, () => {
      const current = readState(fingerprint);
      if (current.corrupt || !current.state) return false;
      const state = current.state;
      if (
        state.attemptToken !== attemptToken ||
        state.status === "confirmed" ||
        (state.reportId !== undefined && state.reportId !== reportId)
      ) {
        return false;
      }
      if (!archiveAdapter) return false;
      const archived = state.status === "pending"
        ? archiveAdapter.byId(reportId)
        : archiveAdapter.settledById(reportId);
      // Pending state is created before settlement and therefore owns a staged
      // authenticated record. Unknown state may be reattached only when the
      // archive already proves a confirmed transaction; otherwise a later
      // retry could bind arbitrary orphan bytes to an uncertain payment.
      if (!archived) return false;
      // Pruning may have won before this record lock was acquired. Never
      // publish a hold for bytes that no longer exist.
      if (!ensureHold(reportId, fingerprint, attemptToken)) {
        return false;
      }
      if (state.reportId === reportId) return true;
      const { mac: _mac, ownerPid: _ownerPid, ownerStartedAt: _ownerStartedAt, ownerToken: _ownerToken, ...unsigned } = state;
      const stamped = stamp({
        ...unsigned,
        reportId,
        updatedAt: new Date().toISOString(),
      });
      if (!stamped) return false;
      try {
        atomicReplace(path, JSON.stringify(stamped));
        return true;
      } catch {
        // The hold may leak retention after a failed state write. That is the
        // safe crash direction: pruning less is preferable to deleting the
        // only report candidate for an uncertain payment.
        return false;
      }
      }),
    );
    return result === true;
  } catch {
    return false;
  }
}

export function markUnknown(
  fingerprint: string,
  attemptToken: string,
  reason: ReplayUnknownReason,
  detail: {
    reportId?: string;
    settlement?: ReplaySettlement;
    settlementEvidence?: ReplaySettlementEvidence;
  } = {},
): boolean {
  try {
    if (!validUnknownReason(reason)) return false;
    if (detail.reportId && !/^[a-f0-9-]{8,64}$/i.test(detail.reportId)) return false;
    if (detail.settlement && !validSettlement(detail.settlement)) return false;
    if (detail.settlementEvidence && !detail.settlement) return false;
    return replaceOwned(fingerprint, attemptToken, (state) => {
      if (state.status === "confirmed") return null;
      // Report ownership is established only by attachReport, which publishes
      // the retention hold before updating replay state under the record lock.
      // Letting an error transition introduce a report id directly would create
      // an unknown payment whose only candidate is unprotected from pruning.
      if (detail.reportId && state.reportId !== detail.reportId) return null;
      const reportId = state.reportId;
      const settlement = detail.settlement ?? state.settlement;
      const settlementEvidence = detail.settlement
        ? detail.settlementEvidence
        : state.settlementEvidence;
      if (
        (reason === "settlement_unreachable" ||
          reason === "settlement_timeout" ||
          reason === "receipt_unconfirmed") &&
        !reportId
      ) {
        return null;
      }
      if (reason === "archive_link_failed" && !reportId) return null;
      if (reason === "replay_commit_failed" && (!reportId || !settlement)) {
        return null;
      }
      if (settlement && !settlementEvidence) return null;
      if (
        (reason === "archive_link_failed" || reason === "replay_commit_failed") &&
        settlement &&
        settlementEvidence !== "confirmed"
      ) {
        return null;
      }
      if (
        reason !== "archive_link_failed" &&
        reason !== "replay_commit_failed" &&
        settlement &&
        settlementEvidence !== "candidate"
      ) {
        return null;
      }
      const { mac: _mac, reason: _reason, reportId: _reportId, settlement: _settlement, settlementEvidence: _settlementEvidence, ownerPid: _ownerPid, ownerStartedAt: _ownerStartedAt, ownerToken: _ownerToken, ...unsigned } = state;
      return {
        ...unsigned,
        status: "unknown",
        reason,
        ...(reportId ? { reportId } : {}),
        ...(settlement ? { settlement } : {}),
        ...(settlementEvidence ? { settlementEvidence } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  } catch {
    return false;
  }
}

/**
 * Record that a fresh status query confirmed the exact transaction previously
 * retained from a non-final settle response. This narrow transition is
 * deliberately separate from finalize: candidate evidence can never create
 * archive ownership until the caller has first upgraded it through this
 * authenticated boundary.
 */
export function confirmSettlementCandidate(
  fingerprint: string,
  attemptToken: string,
  settlement: ReplaySettlement,
): boolean {
  try {
    if (!validSettlement(settlement)) return false;
    return replaceOwned(fingerprint, attemptToken, (state) => {
      if (
        state.status !== "unknown" ||
        !state.reportId ||
        !state.settlement ||
        !settlementSame(state.settlement, settlement)
      ) {
        return null;
      }
      if (
        state.reason === "archive_link_failed" &&
        state.settlementEvidence === "confirmed"
      ) {
        const { mac: _mac, ...unsigned } = state;
        return unsigned;
      }
      if (
        (state.reason !== "settlement_timeout" &&
          state.reason !== "receipt_unconfirmed") ||
        state.settlementEvidence !== "candidate"
      ) {
        return null;
      }
      const {
        mac: _mac,
        reason: _reason,
        settlementEvidence: _settlementEvidence,
        ...unsigned
      } = state;
      return {
        ...unsigned,
        reason: "archive_link_failed",
        settlementEvidence: "confirmed",
        updatedAt: new Date().toISOString(),
      };
    });
  } catch {
    return false;
  }
}

export function finalize(
  fingerprint: string,
  attemptToken: string,
  reportId: string,
  settlement: ReplaySettlement,
): boolean {
  try {
    if (!/^[a-f0-9-]{8,64}$/i.test(reportId) || !validSettlement(settlement)) return false;
    const path = statePath(fingerprint);
    if (!path) return false;
    let previousReportId: string | undefined;
    const result = withReplayLock(fingerprint, () => {
      const current = readState(fingerprint);
      if (current.corrupt || !current.state) return false;
      const state = current.state;
      if (state.attemptToken !== attemptToken) return false;
      if (state.reportId && state.reportId !== reportId) return false;
      if (state.settlement && !settlementSame(state.settlement, settlement)) {
        return false;
      }
      if (state.status === "confirmed") {
        return Boolean(state.settlement && settlementSame(state.settlement, settlement));
      }
      if (
        state.settlement &&
        state.settlementEvidence !== "confirmed"
      ) {
        return false;
      }
      previousReportId = state.reportId;
      const { mac: _mac, reason: _reason, settlementEvidence: _settlementEvidence, ownerPid: _ownerPid, ownerStartedAt: _ownerStartedAt, ownerToken: _ownerToken, ...unsigned } = state;
      const stamped = stamp({
        ...unsigned,
        status: "confirmed",
        reportId,
        settlement,
        updatedAt: new Date().toISOString(),
      });
      if (!stamped) return false;
      atomicReplace(path, JSON.stringify(stamped));
      return true;
    });
    if (result !== true) return false;
    if (previousReportId) {
      // A confirmed transaction claim now protects the report. Hold cleanup is
      // redundant best effort; leaving it behind preserves safety on a crash.
      removeOwnedHold(previousReportId, fingerprint, attemptToken);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Adopt the authoritative owner of an already-claimed transaction conflict.
 * Ordinary finalize deliberately forbids replacing an attached report; this
 * narrower transition requires the caller to name the exact staged report it
 * is replacing and the already-validated settlement identity.
 */
export function adoptConflictOwner(
  fingerprint: string,
  attemptToken: string,
  expectedReportId: string,
  ownerReportId: string,
  settlement: ReplaySettlement,
): boolean {
  try {
    if (
      !/^[a-f0-9-]{8,64}$/i.test(expectedReportId) ||
      !/^[a-f0-9-]{8,64}$/i.test(ownerReportId) ||
      expectedReportId === ownerReportId ||
      !validSettlement(settlement)
    ) {
      return false;
    }
    const path = statePath(fingerprint);
    if (!path) return false;
    const result = withReplayLock(fingerprint, () => {
      const current = readState(fingerprint);
      if (current.corrupt || !current.state) return false;
      const state = current.state;
      if (
        state.attemptToken !== attemptToken ||
        state.status === "confirmed" ||
        state.reportId !== expectedReportId
      ) {
        return false;
      }
      if (
        state.settlement &&
        state.settlementEvidence !== "confirmed"
      ) {
        return false;
      }
      if (state.settlement && !settlementSame(state.settlement, settlement)) return false;
      const { mac: _mac, reason: _reason, settlementEvidence: _settlementEvidence, ownerPid: _ownerPid, ownerStartedAt: _ownerStartedAt, ownerToken: _ownerToken, ...unsigned } = state;
      const stamped = stamp({
        ...unsigned,
        status: "confirmed",
        reportId: ownerReportId,
        settlement,
        updatedAt: new Date().toISOString(),
      });
      if (!stamped) return false;
      atomicReplace(path, JSON.stringify(stamped));
      return true;
    });
    if (result !== true) return false;
    removeOwnedHold(expectedReportId, fingerprint, attemptToken);
    return true;
  } catch {
    return false;
  }
}

function settlementSame(left: ReplaySettlement, right: ReplaySettlement): boolean {
  return (
    left.transaction.toLowerCase() === right.transaction.toLowerCase() &&
    left.network === right.network &&
    (left.amount ?? undefined) === (right.amount ?? undefined) &&
    (left.payer?.toLowerCase() ?? undefined) ===
      (right.payer?.toLowerCase() ?? undefined)
  );
}

export function release(fingerprint: string, attemptToken: string): boolean {
  try {
    const path = statePath(fingerprint);
    if (!path || !archiveAdapter) return false;

    // Read the candidate only to discover which record lock must be acquired.
    // The state is authenticated and then re-read under replay ownership below;
    // a concurrent transition can therefore only make this operation fail.
    const observed = readState(fingerprint);
    if (
      observed.corrupt ||
      !observed.state ||
      observed.state.attemptToken !== attemptToken ||
      observed.state.status !== "pending"
    ) {
      return false;
    }
    const reportId = observed.state.reportId;
    const releaseOwned = () => withReplayLock(fingerprint, () => {
      const current = readState(fingerprint);
      if (current.corrupt || !current.state) return false;
      if (
        current.state.attemptToken !== attemptToken ||
        current.state.status !== "pending" ||
        current.state.reportId !== reportId
      ) {
        return false;
      }
      try {
        unlinkSync(path);
        syncDirectory(join(path, ".."));
      } catch {
        return false;
      }
      // Delete replay ownership before its hold. A crash between the two leaves
      // an obvious, fail-closed retention leak; reversing the order could leave
      // an attached pending state whose report is no longer protected from
      // pruning. The record lock prevents prune/discard from observing a
      // successful release halfway through this sequence.
      return reportId
        ? removeOwnedHold(reportId, fingerprint, attemptToken)
        : true;
    });
    const result = reportId
      ? archiveAdapter.withRetentionLock(reportId, releaseOwned)
      : releaseOwned();
    return result === true;
  } catch {
    return false;
  }
}
