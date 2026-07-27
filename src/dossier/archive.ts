// Durable archive of delivered reports, so a buyer who loses the paid response
// can fetch it again and prove it was not altered.
//
// A paid response can be lost for reasons that have nothing to do with us: the
// client crashes, the connection drops after settlement, the file is
// overwritten. Without this the buyer has paid and the artefact is gone, and we
// have no answer for them. Recovery requires the settlement transaction hash,
// which only the payer can know, so the archive can never be used to obtain a
// report without paying for one.
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
  request: Record<string, unknown>;
  contentType: string;
  deliverable: string;
  deliveredAt: string;
  paymentTransaction?: string;
}

const DIR =
  process.env.ARCHIVE_DIR ||
  join(process.env.HOME || process.env.TMPDIR || "/tmp", ".dossier-archive");
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 5000;
const PRUNE_EVERY = 25;

let sinceLastPrune = 0;

// The archive is a convenience, never a dependency: if the filesystem is
// read-only (a serverless target, say) every operation degrades to a no-op and
// the paid response is unaffected.
let usable = true;
function dir(): string | null {
  if (!usable) return null;
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
    return DIR;
  } catch {
    usable = false;
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
    if (txIndex) txIndex.set(tx.toLowerCase(), id + ".json");
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

// Transaction -> filename index. Without it every recovery request parsed the
// whole archive: harmless at 17 records, but 289ms of CPU and 22MB of disk read
// per request once the archive reaches its 5000-record cap — which turns an
// unauthenticated free endpoint into an amplifier. Built once, then maintained.
let txIndex: Map<string, string> | null = null;

function buildIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  const d = dir();
  if (!d) return idx;
  try {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord;
        if (rec.paymentTransaction) idx.set(rec.paymentTransaction.toLowerCase(), name);
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

export function byTransaction(tx: string): ArchiveRecord | null {
  const want = tx.toLowerCase();
  if (!txIndex) txIndex = buildIndex();

  const hit = txIndex.get(want);
  if (hit) {
    const rec = readByName(hit);
    // Trust the index only as far as the record confirms it; a stale entry
    // must never return the wrong buyer's report.
    if (rec && (rec.paymentTransaction || "").toLowerCase() === want) return rec;
    txIndex = buildIndex();
    const retry = txIndex.get(want);
    if (retry) {
      const again = readByName(retry);
      if (again && (again.paymentTransaction || "").toLowerCase() === want) return again;
    }
  }
  return null;
}

/** Drop the cached index; used by tests and after bulk changes on disk. */
export function resetIndex(): void {
  txIndex = null;
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
    if (removed) txIndex = null; // rebuilt on next lookup
  } catch {
    /* ignore */
  }
}
