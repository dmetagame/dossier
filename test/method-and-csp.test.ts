// Two things a browser or a stray client sees that the rest of the suite does not.
//
// Methods: HEAD once returned 200 with an empty body on a paid call, which the
// SDK settles on, so the buyer was charged for nothing. That specific case is
// fixed and tested; this file covers the rest of the method surface, because
// the property that makes it safe is not "HEAD is handled" but "no method other
// than GET and POST can ever reach a 2xx on a paid route".
//
// CSP: the inline scripts are allowed by hash. If a page ever serves a script
// the header did not hash — a later escaping step, a different constant, a
// build transform — the page silently stops working in every browser while
// every server-side test still passes, because nothing here enforces CSP.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stubUpstream, tempArchive } from "./helpers";
import { app } from "../src/app";

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;

let restore: () => void;
before(() => {
  restore = stubUpstream();
});
after(() => {
  restore();
  cleanup();
});

describe("the method contract", () => {
  // Anything that is not GET or POST must be refused, and refused with a status
  // the payment middleware will not settle on. >= 400 is the whole requirement:
  // the SDK settles only on 2xx, so a non-2xx is structurally unchargeable.
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    test(`${method} /dossier is refused and cannot be charged`, async () => {
      const r = await app.request("/dossier", { method });
      assert.ok(r.status >= 400, `${method} returned ${r.status}, which is settleable`);
      assert.ok(r.status !== 402, `${method} should not be offered a payment challenge`);
    });
  }

  test("HEAD /dossier is refused before any work happens", async () => {
    const r = await app.request("/dossier", { method: "HEAD" });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("Allow"), "GET, POST");
  });

  test("GET and POST both work, so the refusals above are not blanket", async () => {
    for (const method of ["GET", "POST"]) {
      const r = await app.request("/dossier/preflight?tokenAddress=0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", {
        method,
      });
      assert.equal(r.status, 200, method);
    }
  });

  test("the free surface refuses write methods too", async () => {
    for (const path of ["/", "/health", "/info", "/verify"]) {
      for (const method of ["PUT", "DELETE"]) {
        const r = await app.request(path, { method });
        assert.ok(r.status >= 400, `${method} ${path} returned ${r.status}`);
      }
    }
  });
});

describe("the pages actually satisfy their own CSP", () => {
  const b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");

  for (const path of ["/", "/verify"]) {
    test(`every inline script on ${path} is allowed by hash`, async () => {
      const r = await app.request(path);
      assert.equal(r.status, 200);
      const html = await r.text();
      const csp = r.headers.get("content-security-policy");
      assert.ok(csp, `${path} must carry a CSP`);

      const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(
        (m) => m[1],
      );
      assert.ok(scripts.length > 0, `${path} should have an inline script to check`);
      for (const s of scripts) {
        assert.ok(
          csp!.includes(`'sha256-${b64(s)}'`),
          `${path} serves a script the CSP does not allow; the page is broken in browsers`,
        );
      }

      // And the door is not simply open. A hash allowance is worth nothing
      // beside unsafe-inline, which is what a "quick fix" for the above adds.
      const scriptSrc = csp!.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
      assert.ok(!scriptSrc.includes("unsafe-inline"), "script-src must not allow unsafe-inline");
      assert.ok(!scriptSrc.includes("unsafe-eval"), "script-src must not allow unsafe-eval");
    });
  }

  test("no page loads a script from anywhere else", async () => {
    for (const path of ["/", "/verify"]) {
      const html = await (await app.request(path)).text();
      assert.ok(
        !/<script[^>]+\bsrc\s*=/.test(html),
        `${path} must not reference an external script: the CSP allows no host`,
      );
    }
  });
});
