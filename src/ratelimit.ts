// Fixed-window rate limiting for the free surface.
//
// Paid paths are never limited: a buyer who has paid must not be throttled,
// and the 402 challenge itself is cheap to produce. This exists for the
// unauthenticated endpoints, where one cheap HTTP request can cost us real
// work — recovery reads the archive, the sample can rebuild on a cold cache.
//
// Starts in observe mode: it records what it *would* have blocked without
// blocking anything, so real traffic (including OKX's validator and buyers'
// retrying clients) can be checked against the limits before they bite.

export type Mode = "observe" | "enforce";

export interface Limit {
  windowMs: number;
  max: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

// Bounded so the limiter cannot become the memory exhaustion it prevents.
const MAX_TRACKED = 20_000;
const buckets = new Map<string, Counter>();

export const limits: Record<string, Limit> = {
  "/dossier/recovery": { windowMs: 60_000, max: 60 },
  "/dossier/sample": { windowMs: 60_000, max: 60 },
  default: { windowMs: 60_000, max: 240 },
};

export function mode(): Mode {
  return process.env.RATE_LIMIT_MODE === "enforce" ? "enforce" : "observe";
}

/**
 * Client address as seen by our own proxy.
 *
 * Caddy appends the immediate peer to X-Forwarded-For, so the LAST entry is the
 * address it observed. Earlier entries are client-supplied and must never be
 * trusted — reading the first would let anyone rotate their own identity.
 */
export function clientKey(headers: { get(name: string): string | null | undefined }): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = String(xff)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return headers.get("x-real-ip") || "unknown";
}

export interface Decision {
  limited: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

export function check(path: string, key: string, now = Date.now()): Decision {
  const limit = limits[path] ?? limits.default!;
  const id = path + "|" + key;
  let c = buckets.get(id);
  if (!c || now >= c.resetAt) {
    c = { count: 0, resetAt: now + limit.windowMs };
    if (buckets.size >= MAX_TRACKED) evict(now);
    buckets.set(id, c);
  }
  c.count++;
  return {
    limited: c.count > limit.max,
    limit: limit.max,
    remaining: Math.max(0, limit.max - c.count),
    retryAfterSec: Math.max(1, Math.ceil((c.resetAt - now) / 1000)),
  };
}

function evict(now: number): void {
  // Drop anything already expired; if that frees nothing, drop the oldest half
  // rather than let the map grow without bound.
  for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  if (buckets.size < MAX_TRACKED) return;
  const sorted = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (let i = 0; i < Math.floor(sorted.length / 2); i++) buckets.delete(sorted[i]![0]);
}

/** Test seam. */
export function reset(): void {
  buckets.clear();
}
