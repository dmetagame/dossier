/**
 * Run one bounded facilitator-initialisation burst.
 *
 * The caller owns the long-lived retry schedule and observability. This helper
 * owns the two safety invariants that are easy to regress together: one
 * facilitator call cannot hang forever, and a transient failure gets a finite
 * retry burst rather than an unbounded loop.
 */
export interface FacilitatorInitBurstOptions {
  initialize: () => Promise<void>;
  timeoutMs: number;
  burstSize: number;
  retryDelaysMs: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (attempt: number) => void;
  onFailure?: (attempt: number, error: unknown, retryDelayMs: number) => void;
}

export type FacilitatorInitBurstResult =
  | { kind: "ready"; attempts: number }
  | { kind: "exhausted"; attempts: number; lastError?: unknown };

/**
 * Reuse a still-running initialization invocation across timeout retries and
 * later bursts. The OKX SDK does not accept an AbortSignal, so starting another
 * request after our local timeout would create overlapping late writes to its
 * internal supported-kind maps.
 */
export function singleFlight<T>(start: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const current = Promise.resolve().then(start);
    inFlight = current;
    void current.then(
      () => {
        if (inFlight === current) inFlight = undefined;
      },
      () => {
        if (inFlight === current) inFlight = undefined;
      },
    );
    return current;
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("facilitator initialization timeout is invalid"));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("facilitator initialization timed out")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runFacilitatorInitBurst(
  options: FacilitatorInitBurstOptions,
): Promise<FacilitatorInitBurstResult> {
  const burstSize = Math.max(1, Math.floor(options.burstSize));
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= burstSize; attempt++) {
    options.onAttempt?.(attempt);
    try {
      await withTimeout(options.initialize(), options.timeoutMs);
      return { kind: "ready", attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryDelayMs = Math.max(
        0,
        options.retryDelaysMs[attempt - 1] ?? 0,
      );
      options.onFailure?.(attempt, error, retryDelayMs);
      if (retryDelayMs > 0 && attempt < burstSize) {
        await sleep(retryDelayMs);
      }
    }
  }
  return { kind: "exhausted", attempts: burstSize, lastError };
}
