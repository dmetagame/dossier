// The verifier, in a real browser engine.
//
// /verify is the one page here that renders bytes an attacker chooses, and it
// is the page whose whole purpose is proving a document has not been tampered
// with. Before the DOM rewrite it concatenated every field of a pasted
// attestation into innerHTML, so a crafted `?attestation=` link executed script
// on this origin — and executed it whether or not the signature checked out,
// because the rendering happened either way.
//
// Every existing test of that page is a string search over server-rendered
// HTML. A string search cannot tell "the value is escaped" from "the value is
// executed": both leave the same bytes in the response. Only a browser can
// answer it, so this file runs one — real chromium, the real page, the real
// CSP, over a real socket.
//
// Kept out of `pnpm test` so the everyday loop needs no browser. CI runs it as
// its own step, which is what stops it from quietly rotting.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { serve } from "@hono/node-server";
import { stubUpstream, tempArchive, ADDR } from "../helpers";

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;
process.env.DEV_SKIP_PAYMENT = "1";
// A fixed seed, so the page has a real signature to check rather than the
// "no signature, only a hash" path. Not a production key: production reads its
// own from the environment and this value is in a public test file.
process.env.SIGNING_KEY = "11".repeat(32);

const { app } = await import("../../src/app");

let browser: Browser;
let page: Page;
let origin: string;
let server: ReturnType<typeof serve>;
let restore: () => void;
/** A real, signed report, straight out of the service. */
let report: any;

before(async () => {
  restore = stubUpstream();
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const res = await app.request(`/dossier?tokenAddress=${ADDR.cake}&format=json`);
  assert.equal(res.status, 200, "the fixture report must build");
  report = await res.json();
  assert.ok(report.attestation?.signature, "and must be signed");

  browser = await chromium.launch();
  page = await browser.newPage();
  // Anything the page fails to load, or any policy it violates, is a failure
  // worth seeing rather than a silently degraded page.
  page.on("pageerror", (e) => console.error("[page error]", e.message));
});

after(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  restore();
  cleanup();
});

/** Paste `input`, click Verify, and read back what the page decided. */
async function verify(input: unknown, pinnedKey?: string) {
  await page.goto(`${origin}/verify`);
  await page.fill("#input", typeof input === "string" ? input : JSON.stringify(input));
  if (pinnedKey !== undefined) await page.fill("#key", pinnedKey);
  await page.click("#go");
  await page.waitForSelector("#out .r");
  return readResults();
}

async function readResults(): Promise<{ verdict: string; text: string }[]> {
  return page.$$eval("#out .r", (nodes) =>
    nodes.map((n) => ({
      verdict: n.classList.contains("ok") ? "PASS" : n.classList.contains("no") ? "FAIL" : "-",
      text: (n.textContent || "").trim(),
    })),
  );
}

const find = (rows: { text: string }[], needle: string) => {
  const hit = rows.find((r) => r.text.includes(needle));
  assert.ok(hit, `no result line matching ${JSON.stringify(needle)} in:\n${rows.map((r) => "  " + r.text).join("\n")}`);
  return hit as { verdict: string; text: string };
};

describe("checking a report", () => {
  test("a real report passes every check, in the browser", async () => {
    const rows = await verify(report);
    assert.equal(find(rows, "hashes to the value").verdict, "PASS");
    assert.equal(find(rows, "signature is valid").verdict, "PASS");
    assert.equal(
      find(rows, "not registered in the code-reviewed Dossier trust registry").verdict,
      "FAIL",
      "the public test key proves cryptographic validity without impersonating Dossier",
    );
    assert.equal(find(rows, "whole report matches").verdict, "PASS");

    // The page's own script running at all is the proof that the CSP hash
    // covers it. If the policy did not, the click would do nothing and there
    // would be no rows to read.
    assert.ok(rows.length >= 3);
  });

  test("the facts it prints come from the payload, not from the document", async () => {
    await verify(report);
    const facts = await page.$$eval(".facts .f", (nodes) =>
      nodes.map((n) => (n.textContent || "").trim()),
    );
    assert.ok(
      facts.some((f) => f.includes(report.attestation.payload.reportId)),
      "the report id is shown",
    );
    assert.ok(facts.some((f) => f.toLowerCase().includes(ADDR.cake)), "and the token");
  });

  test("an altered figure in the document is caught", async () => {
    const tampered = JSON.parse(JSON.stringify(report));
    // The kind of edit that matters: the verdict text a reader acts on, left
    // inside a report whose attestation is untouched and still valid.
    tampered.riskVerdict.verdict = "safe";
    const rows = await verify(tampered);
    assert.equal(find(rows, "hashes to the value").verdict, "PASS", "the payload itself is intact");
    assert.equal(find(rows, "signature is valid").verdict, "PASS");
    assert.equal(
      find(rows, "does NOT match the hash").verdict,
      "FAIL",
      "but the document no longer matches what was signed",
    );
  });

  test("an altered payload is caught", async () => {
    const tampered = JSON.parse(JSON.stringify(report));
    tampered.attestation.payload.result.verdict = "safe";
    const rows = await verify(tampered);
    assert.equal(find(rows, "does NOT hash").verdict, "FAIL");
  });

  test("a signature from another key is caught", async () => {
    const rows = await verify(report, "d".repeat(43));
    assert.equal(find(rows, "different key").verdict, "FAIL");
  });

  test("the published key can be fetched into the page and it matches", async () => {
    // Exercises `connect-src 'self'`: with the CSP wrong, this fetch is blocked
    // and the field stays empty.
    await page.goto(`${origin}/verify`);
    await page.fill("#input", JSON.stringify(report));
    await page.click("#fetchkey");
    await page.waitForFunction(() => (document.querySelector("#key") as HTMLInputElement).value !== "");
    assert.equal(
      await page.inputValue("#key"),
      report.attestation.publicKey,
      "the key the service publishes is the key the report was signed with",
    );
    await page.click("#go");
    await page.waitForSelector("#out .r");
    assert.equal(find(await readResults(), "signature is valid").verdict, "PASS");
    assert.equal(
      find(await readResults(), "not registered in the code-reviewed Dossier trust registry").verdict,
      "FAIL",
    );
  });

  test("the browser uses its compiled trust registry, not the mutable published-key response", async () => {
    const html = await (await app.request("/verify")).text();
    assert.ok(html.includes("oOO5AkCXfVbXwSr3j6FBlKUv6mAwCKE9SE7f_zUS6e4"));
    assert.ok(html.includes("code-reviewed Dossier trust registry"));
    assert.equal(/fetch\([^)]*dossier-signing-keys/.test(html), false);
  });
});

// The payload fields the page prints, each carrying a different shape of
// injection. Every one of these reached innerHTML before the rewrite.
const HOSTILE = {
  reportId: '<img src=x onerror="window.__pwned=1">',
  token: {
    address: '"><script>window.__pwned=1</script>',
    chain: "<svg onload=\"window.__pwned=1\">",
  },
  result: { verdict: "<iframe src=javascript:window.__pwned=1>", coverage: 1 },
  issuedAt: "2026-08-04T00:00:00.000Z",
  issuer: { agentId: '<body onload="window.__pwned=1">' },
  methodologyVersion: "</script><script>window.__pwned=1</script>",
  observations: [
    { source: '<img src=y onerror="window.__pwned=1">', status: "ok", retrievedAt: "now" },
  ],
};

describe("hostile input", () => {
  test("every field renders as text and nothing executes", async () => {
    const rows = await verify({
      payload: HOSTILE,
      payloadSha256: "0".repeat(64),
      signature: "",
    });

    // It still reaches a verdict rather than falling over.
    assert.equal(find(rows, "does NOT hash").verdict, "FAIL");

    assert.equal(
      await page.evaluate(() => (window as any).__pwned),
      undefined,
      "no injected handler ran",
    );
    // Not one of those payloads became an element. `textContent` is the whole
    // defence and this is what proves it is still in place.
    assert.equal(
      await page.$$eval("#out img, #out iframe, #out svg, #out script", (n) => n.length),
      0,
      "hostile markup must not become elements",
    );
    // And the buyer can still see what was in the field.
    const facts = await page.$$eval(".facts .f", (n) => n.map((x) => x.textContent || ""));
    assert.ok(
      facts.some((f) => f.includes("<img src=x onerror=")),
      "the hostile value is shown as the text it is",
    );
  });

  test("the ?attestation= link is not a way in either", async () => {
    // The original vector: rendering happened on load, before any check, so the
    // link executed on arrival with no interaction at all.
    const att = { payload: HOSTILE, payloadSha256: "0".repeat(64), signature: "" };
    const packed = Buffer.from(JSON.stringify(att), "utf8").toString("base64url");
    await page.goto(`${origin}/verify?attestation=${packed}`);
    await page.waitForSelector("#out .r");

    assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
    assert.equal(await page.$$eval("#out img, #out iframe, #out svg", (n) => n.length), 0);
    // The link did run the check, which is the feature.
    assert.equal(find(await readResults(), "does NOT hash").verdict, "FAIL");
  });

  test("a corrupt link says so rather than throwing", async () => {
    await page.goto(`${origin}/verify?attestation=not-base64-at-all%%%`);
    await page.waitForSelector("#out .r");
    assert.equal(find(await readResults(), "could not be decoded").verdict, "FAIL");
  });
});

describe("the content security policy, as the browser enforces it", () => {
  test("an injected inline script does not run", async () => {
    await page.goto(`${origin}/verify`);
    const violations: string[] = [];
    await page.exposeFunction("__violation", (d: string) => void violations.push(d));
    await page.evaluate(() => {
      document.addEventListener("securitypolicyviolation", (e: any) =>
        (window as any).__violation(e.violatedDirective),
      );
      const s = document.createElement("script");
      s.textContent = "window.__csp_bypassed = 1";
      document.body.appendChild(s);
    });
    assert.equal(
      await page.evaluate(() => (window as any).__csp_bypassed),
      undefined,
      "script-src by hash must reject a script the page did not ship with",
    );
    assert.ok(
      violations.some((v) => v.startsWith("script-src")),
      `expected a script-src violation, saw ${JSON.stringify(violations)}`,
    );
  });

  test("the page cannot be framed and loads nothing from anywhere else", async () => {
    const res = await page.goto(`${origin}/verify`);
    const csp = res!.headers()["content-security-policy"];
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.equal(res!.headers()["x-frame-options"], "DENY");
    assert.equal(res!.headers()["x-content-type-options"], "nosniff");

    // Nothing on the page came from another origin.
    const external: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith("data:")) external.push(r.url());
    });
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(external, []);
  });
});

describe("the report document itself", () => {
  test("renders in a browser and pulls in nothing external", async () => {
    const external: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith("data:")) external.push(r.url());
    });
    const res = await page.goto(`${origin}/dossier/sample`, { waitUntil: "networkidle" });
    assert.equal(res!.status(), 200);
    assert.deepEqual(external, [], "a report a buyer opens must not phone anywhere");
    // A printable document, not an app: no script at all means nothing to
    // execute even if a future field is rendered unsafely.
    assert.equal(await page.$$eval("script", (n) => n.length), 0);
    assert.ok((await page.textContent("body"))!.length > 500, "and it has content");
  });
});
