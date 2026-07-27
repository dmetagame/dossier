// The limiter protects the free surface. It must never touch a paid path, must
// not be evadable by a header anyone can set, and must leave a trace when it
// blocks someone.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as rl from "../src/ratelimit";

beforeEach(() => rl.reset());

const burst = (path: string, key: string, n: number) => {
  let limited = 0;
  for (let i = 0; i < n; i++) if (rl.check(path, key).limited) limited++;
  return limited;
};

describe("budgets", () => {
  test("recovery allows 60 a minute, then blocks", () => {
    assert.equal(burst("/dossier/recovery", "1.1.1.1", 60), 0);
    assert.equal(rl.check("/dossier/recovery", "1.1.1.1").limited, true);
  });

  test("preflight is tighter, because it calls both upstreams", () => {
    assert.equal(burst("/dossier/preflight", "1.1.1.1", 30), 0);
    assert.equal(rl.check("/dossier/preflight", "1.1.1.1").limited, true);
  });

  test("an unlisted path falls back to the default budget", () => {
    assert.equal(burst("/info", "1.1.1.1", 240), 0);
    assert.equal(rl.check("/info", "1.1.1.1").limited, true);
  });

  test("one client's flood does not affect another", () => {
    burst("/dossier/recovery", "noisy", 100);
    assert.equal(rl.check("/dossier/recovery", "quiet").limited, false);
  });

  test("the window rolls over", () => {
    burst("/dossier/recovery", "1.1.1.1", 61);
    assert.equal(rl.check("/dossier/recovery", "1.1.1.1", Date.now() + 61_000).limited, false);
  });
});

describe("client identity cannot be spoofed away", () => {
  const hdrs = (v: string | null) => ({ get: (n: string) => (n === "x-forwarded-for" ? v : null) });

  test("the last forwarded-for entry wins, because our proxy appends it", () => {
    // A client sending its own X-Forwarded-For prepends; Caddy appends the peer
    // it actually saw. Reading the first entry would let anyone rotate identity.
    assert.equal(rl.clientKey(hdrs("1.2.3.4, 9.9.9.9")), "9.9.9.9");
  });

  test("a single entry is used as-is", () => {
    assert.equal(rl.clientKey(hdrs("9.9.9.9")), "9.9.9.9");
  });

  test("no header falls back to a constant, not to a random per-request key", () => {
    assert.equal(rl.clientKey(hdrs(null)), "unknown");
  });
});

describe("blocks are observable", () => {
  test("the first block is worth logging, and then every hundredth", () => {
    const logged: number[] = [];
    for (let i = 1; i <= 200; i++) {
      const d = rl.check("/dossier/recovery", "k", Date.now());
      if (rl.worthLogging(d)) logged.push(i);
    }
    assert.deepEqual(logged, [61, 160]);
  });

  test("a request inside the budget is never logged", () => {
    assert.equal(rl.worthLogging(rl.check("/dossier/recovery", "k")), false);
  });

  test("overBy counts how far past the budget a request is", () => {
    burst("/dossier/recovery", "k", 60);
    assert.equal(rl.check("/dossier/recovery", "k").overBy, 1);
    assert.equal(rl.check("/dossier/recovery", "k").overBy, 2);
  });
});

describe("mode", () => {
  test("defaults to observe, so budgets can be watched before they bite", () => {
    delete process.env.RATE_LIMIT_MODE;
    assert.equal(rl.mode(), "observe");
    process.env.RATE_LIMIT_MODE = "enforce";
    assert.equal(rl.mode(), "enforce");
    delete process.env.RATE_LIMIT_MODE;
  });
});

describe("the limiter cannot become the exhaustion it prevents", () => {
  test("tracking is bounded", () => {
    for (let i = 0; i < 25_000; i++) rl.check("/dossier/recovery", `client-${i}`);
    // Still answering correctly after eviction rather than growing without end.
    assert.equal(rl.check("/dossier/recovery", "fresh").limited, false);
  });
});
