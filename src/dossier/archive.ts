// Durable archive of delivered reports, so a buyer who loses the paid response
// can fetch it again and prove it was not altered.
//
// A paid response can be lost for reasons that have nothing to do with us: the
// client crashes, the connection drops after settlement, the file is
// overwritten. Without this the buyer has paid and the artefact is gone, and we
// have no answer for them. Recovery requires the settlement transaction hash,
// which only the payer can know, so the archive can never be used to obtain a
// report without paying for one.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArchiveRecord {
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

/** Canonical hash of the request parameters that produced a report. */
export function paramsHash(params: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== "") canonical[k] = String(v).toLowerCase();
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function file(hash: string): string | null {
  const d = dir();
  return d ? join(d, hash + ".json") : null;
}

export function save(rec: ArchiveRecord): void {
  const f = file(rec.paramsSha256);
  if (!f) return;
  try {
    writeFileSync(f, JSON.stringify(rec), { mode: 0o600 });
    prune();
  } catch {
    /* archiving must never break a delivery */
  }
}

/** Attach the settlement transaction once the SDK has settled the payment. */
export function linkTransaction(hash: string, tx: string): void {
  const f = file(hash);
  if (!f) return;
  try {
    if (!existsSync(f)) return;
    const rec = JSON.parse(readFileSync(f, "utf8")) as ArchiveRecord;
    rec.paymentTransaction = tx;
    writeFileSync(f, JSON.stringify(rec), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export function byHash(hash: string): ArchiveRecord | null {
  const f = file(hash);
  if (!f) return null;
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ArchiveRecord) : null;
  } catch {
    return null;
  }
}

export function byTransaction(tx: string): ArchiveRecord | null {
  const d = dir();
  if (!d) return null;
  const want = tx.toLowerCase();
  try {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(d, name), "utf8")) as ArchiveRecord;
        if ((rec.paymentTransaction || "").toLowerCase() === want) return rec;
      } catch {
        /* skip unreadable record */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
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
    for (const f of files) if (now - f.mtime > MAX_AGE_MS) unlinkSync(f.p);
    const left = files.filter((f) => now - f.mtime <= MAX_AGE_MS).sort((a, b) => a.mtime - b.mtime);
    for (let i = 0; i < left.length - MAX_RECORDS; i++) unlinkSync(left[i]!.p);
  } catch {
    /* ignore */
  }
}
