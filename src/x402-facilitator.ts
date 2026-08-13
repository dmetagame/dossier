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
  /** Bounded direct settle fields used to recognize SDK timeout recovery. */
  settlementAnswer?: {
    success?: boolean;
    status?: string;
    transaction?: string;
    network?: string;
    amount?: string;
    payer?: string;
  };
  /** Requirements the facilitator was asked to settle for this request. */
  settlementExpected?: {
    scheme?: string;
    network?: string;
    amount?: string;
    asset?: string;
    payTo?: string;
  };
  /** Payer identity returned by the successful verification response. */
  verifiedPayer?: string;
  /** Bounded observations from the SDK's settle/status timeout polling. */
  settlementPoll?: {
    transaction?: string;
    attempts: number;
    unreached?: string;
    answer?: {
      success?: boolean;
      status?: string;
      transaction?: string;
      network?: string;
      amount?: string;
      payer?: string;
    };
  };
  /** Request-local durable replay state, populated by the pre-verify hook. */
  replay?: {
    fingerprint?: string;
    attemptToken?: string;
    reconciliationId?: string;
    /** Report staged by the paid handler before settlement starts. */
    reportId?: string;
    request?: {
      paramsSha256: string;
      contentType: "text/html" | "application/json" | "invalid";
    };
    /** New authorization that passed facilitator verification but could not
     * publish durable replay ownership. The response must fail closed before
     * the paid handler is allowed to run. */
    beginFailed?: true;
    decision?:
      | { kind: "confirmed"; state: unknown }
      | { kind: "in_flight"; state: unknown }
      | { kind: "corrupt" | "unavailable" };
  };
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

/** Current request's payment observations, for SDK lifecycle hooks and routes. */
export function currentFacilitatorState(): Unreached | undefined {
  return store.getStore();
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
 * A Proxy rather than a subclass on purpose. Unknown methods pass through, but
 * verify, settle, and timeout polling are bounded and observed because all
 * three affect whether a buyer may safely retry.
 */
export function watchFacilitator<T extends object>(inner: T): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== "verify" && prop !== "settle" && prop !== "getSettleStatus") {
        return fn.bind(target);
      }
      return async (...args: unknown[]) => {
        const unreached = store.getStore();
        if (unreached && prop === "settle") {
          const requirements = args[1];
          if (requirements && typeof requirements === "object") {
            const r = requirements as Record<string, unknown>;
            unreached.settlementExpected = {
              ...(typeof r.scheme === "string" ? { scheme: r.scheme } : {}),
              ...(typeof r.network === "string" ? { network: r.network } : {}),
              ...(typeof r.amount === "string" ? { amount: r.amount } : {}),
              ...(typeof r.asset === "string" ? { asset: r.asset } : {}),
              ...(typeof r.payTo === "string" ? { payTo: r.payTo } : {}),
            };
          }
        }
        if (unreached && prop === "getSettleStatus") {
          const transaction = args[0];
          unreached.settlementPoll ??= { attempts: 0 };
          unreached.settlementPoll.attempts++;
          if (typeof transaction === "string") {
            unreached.settlementPoll.transaction = transaction;
          }
        }
        try {
          const answer = await fn.apply(target, args);
          if (unreached && prop === "verify" && answer && typeof answer === "object") {
            const a = answer as Record<string, unknown>;
            if (a.isValid === true && typeof a.payer === "string") {
              unreached.verifiedPayer = a.payer;
            }
          }
          if (unreached && prop === "settle" && answer && typeof answer === "object") {
            const a = answer as Record<string, unknown>;
            unreached.settlementAnswer = {
              ...(typeof a.success === "boolean" ? { success: a.success } : {}),
              ...(typeof a.status === "string" ? { status: a.status } : {}),
              ...(typeof a.transaction === "string"
                ? { transaction: a.transaction }
                : {}),
              ...(typeof a.network === "string" ? { network: a.network } : {}),
              ...(typeof a.amount === "string" ? { amount: a.amount } : {}),
              ...(typeof a.payer === "string" ? { payer: a.payer } : {}),
            };
          }
          if (
            unreached &&
            prop === "getSettleStatus" &&
            answer &&
            typeof answer === "object"
          ) {
            const a = answer as Record<string, unknown>;
            unreached.settlementPoll ??= { attempts: 1 };
            unreached.settlementPoll.answer = {
              ...(typeof a.success === "boolean" ? { success: a.success } : {}),
              ...(typeof a.status === "string" ? { status: a.status } : {}),
              ...(typeof a.transaction === "string"
                ? { transaction: a.transaction }
                : {}),
              ...(typeof a.network === "string" ? { network: a.network } : {}),
              ...(typeof a.amount === "string" ? { amount: a.amount } : {}),
              ...(typeof a.payer === "string" ? { payer: a.payer } : {}),
            };
          }
          return answer;
        } catch (e) {
          if (unreached && (prop === "verify" || prop === "settle")) {
            unreached[prop] = why(e);
          }
          if (unreached && prop === "getSettleStatus") {
            unreached.settlementPoll ??= { attempts: 1 };
            unreached.settlementPoll.unreached = why(e);
          }
          throw e;
        }
      };
    },
  }) as T;
}
