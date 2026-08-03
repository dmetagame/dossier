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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArchiveRecord {
  /** Unique per delivery; also the filename. */
  id: string;
  /** Hash of the semantic request, used only as a secondary proof check. */
  paramsSha256: string;
  /**
   * The same hash, but with the chain we resolved rather than the one the buyer
   * sent. A buyer who omitted the chain gets recovery instructions and a report
   * that both name the resolved one, so proving ownership with either form has
   * to work. Matching only the request as sent returned 403 on the exact command
   * we printed for them.
   */
  resolvedParamsSha256?: string;
  request: Record<string, unknown>;
  contentType: string;
  deliverable: string;
  deliveredAt: string;
  paymentTransaction?: string;
  /**
   * Marketplace job this was delivered into, for buyers who paid at the task
   * level instead of over x402. Those deliveries settle no transaction, so
   * without this they had no proof to recover against.
   */
  jobId?: string;
}

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

let sinceLastPrune = 0;

// The archive is a convenience, never a dependency: if the filesystem is
// read-only (a serverless target, say) every operation degrades to a no-op and
// the paid response is unaffected.
let unusable: string | null = null;
function dir(): string | null {
  const d = configuredDir();
  if (unusable === d) return null;
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  } catch {
    unusable = d;
    return null;
  }
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

export function save(rec: ArchiveRecord): void {
  const f = file(rec.id);
  if (!f) return;
  try {
    writeFileSync(f, JSON.stringify(rec), { mode: 0o600 });
    // Keep a live index current rather than discarding it: a delivery saved
    // after the index was built must still be recoverable immediately.
    if (index && rec.jobId) setJob(index, rec.jobId, rec, rec.id + ".json");
    if (++sinceLastPrune >= PRUNE_EVERY) {
      sinceLastPrune = 0;
      prune();
    }
  } catch {
    /* archiving must never break a delivery */
  }
}

/** Attach the settlement transaction once the SDK has settled the payment. */
export function linkTransaction(id: string, tx: string): void {
  const f = file(id);
  if (!f) return;
  try {
    if (!existsSync(f)) return;
    const rec = JSON.parse(readFileSync(f, "utf8")) as ArchiveRecord;
    rec.paymentTransaction = tx;
    writeFileSync(f, JSON.stringify(rec), { mode: 0o600 });
    if (index) index.tx.set(tx.toLowerCase(), id + ".json");
  } catch {
    /* ignore */
  }
}

function readAll(): ArchiveRecord[] {
  const d = dir();
  if (!d) return [];
  const out: ArchiveRecord[] = [];
  try {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord);
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
  const idx: Index = { tx: new Map(), job: new Map() };
  const d = dir();
  if (!d) return idx;
  // Chosen job records are held here during the walk so a duplicate job id is
  // resolved in memory rather than by re-reading the file it points at.
  const jobRec = new Map<string, ArchiveRecord>();
  try {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord;
        if (rec.paymentTransaction) idx.tx.set(rec.paymentTransaction.toLowerCase(), name);
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
    return JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord;
  } catch {
    return null;
  }
}

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
  return lookup(
    tx.toLowerCase(),
    (i) => i.tx,
    (r) => r.paymentTransaction || "",
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

/** Most recent delivery matching a semantic request hash. */
export function byHash(hash: string): ArchiveRecord | null {
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
  const matches = readAll()
    .filter((r) => r.paramsSha256 === hash)
    .sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : -1));
  return matches[0] ?? null;
}

function prune(): void {
  const d = dir();
  if (!d) return;
  try {
    const now = Date.now();
    const files = readdirSync(d)
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        const p = join(d, n);
        return { p, mtime: statSync(p).mtimeMs };
      });
    let removed = 0;
    for (const f of files) if (now - f.mtime > MAX_AGE_MS) { unlinkSync(f.p); removed++; }
    const left = files.filter((f) => now - f.mtime <= MAX_AGE_MS).sort((a, b) => a.mtime - b.mtime);
    for (let i = 0; i < left.length - MAX_RECORDS; i++) { unlinkSync(left[i]!.p); removed++; }
    if (removed) index = null; // rebuilt on next lookup
  } catch {
    /* ignore */
  }
}
