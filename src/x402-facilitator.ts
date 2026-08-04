// Telling "your payment is invalid" apart from "we could not check your payment".
//
// The x402 SDK does not distinguish them. A verify call that never reaches the
// facilitator — a network failure, a 500, a revoked key — is caught inside
// `processHTTPRequest` and turned into a fresh 402 challenge with the transport
// error as its stated reason. A settle call that never reaches the facilitator
// is caught inside `processSettlement` and turned into a 402 with an empty body.
// Both say `Payment Required` to a buyer who has just signed a payment.
//
// Everywhere else, this service refuses to report an unknown as a known. A
// source that is down yields `unknown` checks and a lower coverage figure, never
// a passing one. A deliverable lookup that fails is tri-state, and both callers
// skip rather than act, because acting would mean chasing a buyer because a
// lookup failed. State that cannot be read stops the watcher instead of letting
// it forget. A 402 on an unreachable facilitator is the same mistake in the one
// place where being wrong costs the buyer money to discover.
//
// The settle case is the worse of the two. If our settle call fails in transit,
// the payment may well have settled: the buyer's authorization is signed and
// OKX may have submitted it. Answering `Payment Required` invites them to sign
// a second one.
//
// So: this records, per request, any facilitator call that came back with no
// answer at all. A call that answers `isValid: false`, or answers that
// settlement failed on chain, is an answer and is not recorded — a real refusal
// must keep looking like a real refusal. `src/app.ts` reads the record and
// relabels the SDK's 402 as a 503 that says which of the two happened.

import { AsyncLocalStorage } from "node:async_hooks";

/** Facilitator calls that produced no answer during one request. */
export interface Unreached {
  verify?: string;
  settle?: string;
}

const store = new AsyncLocalStorage<Unreached>();

/**
 * Runs `fn` with a fresh record. Everything the payment middleware does for one
 * request has to happen inside this, or nothing is recorded.
 */
export function trackFacilitator<T>(fn: (unreached: Unreached) => Promise<T>): Promise<T> {
  const unreached: Unreached = {};
  return store.run(unreached, () => fn(unreached));
}

const why = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  // Bounded, because it is written into a log line and never into a response:
  // the buyer is told that we could not reach the facilitator, not what it said.
  return m.slice(0, 160);
};

/**
 * Wraps a facilitator client so a throwing `verify` or `settle` is recorded and
 * then rethrown unchanged. The SDK's own handling is left exactly as it was;
 * this only remembers what happened.
 *
 * A Proxy rather than a subclass on purpose. The resource server also calls
 * `getSupported` and `getSettleStatus`, and the SDK is free to add more; every
 * method other than the two named here passes straight through, so a new one
 * cannot be silently dropped by this file.
 */
export function watchFacilitator<T extends object>(inner: T): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== "verify" && prop !== "settle") return fn.bind(target);
      return async (...args: unknown[]) => {
        try {
          return await fn.apply(target, args);
        } catch (e) {
          const unreached = store.getStore();
          if (unreached) unreached[prop as "verify" | "settle"] = why(e);
          throw e;
        }
      };
    },
  }) as T;
}
