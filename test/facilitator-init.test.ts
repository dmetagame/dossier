import assert from "node:assert/strict";
import { test } from "node:test";

import { runFacilitatorInitBurst, singleFlight } from "../src/facilitator-init";

test("facilitator initialization times out instead of waiting forever", async () => {
  const started = Date.now();
  const failures: string[] = [];
  const result = await runFacilitatorInitBurst({
    initialize: () => new Promise<void>(() => undefined),
    timeoutMs: 10,
    burstSize: 1,
    retryDelaysMs: [],
    onFailure: (_, error) => failures.push(String((error as Error).message)),
  });
  assert.equal(result.kind, "exhausted");
  assert.equal(result.attempts, 1);
  assert.deepEqual(failures, ["facilitator initialization timed out"]);
  assert.ok(Date.now() - started < 500, "timeout must be bounded");
});

test("facilitator initialization exhausts a finite retry burst", async () => {
  let calls = 0;
  const attempts: number[] = [];
  const delays: number[] = [];
  const result = await runFacilitatorInitBurst({
    initialize: async () => {
      calls++;
      throw new Error("facilitator unavailable");
    },
    timeoutMs: 100,
    burstSize: 3,
    retryDelaysMs: [10, 20],
    sleep: async (ms) => delays.push(ms),
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(result.kind, "exhausted");
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [10, 20]);
  assert.match(String((result as { lastError?: unknown }).lastError), /unavailable/);
});

test("facilitator initialization recovers on a later attempt", async () => {
  let calls = 0;
  const failures: number[] = [];
  const result = await runFacilitatorInitBurst({
    initialize: async () => {
      calls++;
      if (calls === 1) throw new Error("transient outage");
    },
    timeoutMs: 100,
    burstSize: 3,
    retryDelaysMs: [5, 5],
    sleep: async () => undefined,
    onFailure: (attempt) => failures.push(attempt),
  });
  assert.deepEqual(result, { kind: "ready", attempts: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(failures, [1]);
});

test("timeout retries reuse one still-running facilitator invocation", async () => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const initialize = singleFlight(() => {
    calls++;
    return pending;
  });
  const result = await runFacilitatorInitBurst({
    initialize,
    timeoutMs: 5,
    burstSize: 3,
    retryDelaysMs: [1, 1],
    sleep: async () => undefined,
  });
  assert.equal(result.kind, "exhausted");
  assert.equal(calls, 1, "late initialization must not overlap itself");

  release();
  await pending;
  await Promise.resolve();
  await initialize();
  assert.equal(calls, 2, "a settled invocation allows a later recovery call");
});
