// The HTTP contract a buyer and an OKX validator actually see.
//
// Runs with DEV_SKIP_PAYMENT=1 (set by `pnpm test`), so the paid routes are
// reachable without facilitator credentials. The one thing that cannot be
// exercised here is the signed 402 challenge itself, which needs live OKX
// credentials; its published shape is covered by x402-contract.test.ts.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { stubUpstream, tempArchive, ADDR } from "./helpers";
import { app } from "../src/app";
import * as archive from "../src/dossier/archive";
import { verifyAttestation } from "../src/attest";

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

const get = (path: string) => app.request(path);
const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("the free surface", () => {
  test("the landing page renders and carries the hero", async () => {
    const r = await get("/");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("hero-viz"));
    assert.ok(html.includes('id="use"'), "the publicly linked anchor must exist");
  });

  test("the landing page is the only place motion loads", async () => {
    const html = await (await get("/")).text();
    assert.ok(html.includes("<script"));
    const sample = await (await get("/dossier/sample")).text();
    assert.equal(/gsap|lenis/i.test(sample), false, "a printable report loads no animation");
    assert.equal(sample.includes("/f/"), false, "and no webfonts");
  });

  test("/info describes every route a machine needs", async () => {
    const j = (await (await get("/info")).json()) as { endpoints: { path: string }[] };
    const paths = j.endpoints.map((e) => e.path);
    for (const p of ["/dossier", "/dossier/sample", "/dossier/preflight"]) {
      assert.ok(paths.includes(p), `${p} missing from /info`);
    }
  });

  test("/health separates payment being configured from payment working", async () => {
    // A two-hour outage hid behind exactly this distinction: credentials were
    // present, so "configured" was true, while every paid call answered 503.
    const j = (await (await get("/health")).json()) as Record<string, unknown>;
    assert.equal(j.ok, true);
    assert.ok("paymentConfigured" in j);
    assert.ok("paymentLayer" in j, "the live state is what a monitor needs");
    assert.ok(
      ["disabled", "not_configured", "connecting", "ready", "failing"].includes(String(j.paymentLayer)),
      `unexpected paymentLayer: ${j.paymentLayer}`,
    );
    assert.ok("signing" in j);
  });

  test("/health stays 200 when payments are down, because the free surface is not", async () => {
    // Failing health here would take the landing page, the sample, the
    // preflight and recovery down with the payment layer, which is worse.
    const r = await get("/health");
    assert.equal(r.status, 200);
  });

  test("fonts are served from our own origin with a long cache", async () => {
    const html = await (await get("/")).text();
    const path = html.match(/\/f\/[a-z-]+-[a-f0-9]{8}\.woff2/)?.[0];
    assert.ok(path, "the page should reference hashed font paths");
    const r = await get(path!);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "font/woff2");
    assert.match(r.headers.get("cache-control") ?? "", /immutable/);
  });

  test("an unknown font path 404s rather than reading the disk", async () => {
    assert.equal((await get("/f/../../etc/passwd")).status, 404);
    assert.equal((await get("/f/nope-00000000.woff2")).status, 404);
  });
});

describe("input validation happens before anything is produced", () => {
  test("a missing tokenAddress is rejected with usable guidance", async () => {
    const r = await post("/dossier", {});
    assert.equal(r.status, 400);
    const j = (await r.json()) as Record<string, any>;
    assert.ok(j.hint.includes("tokenAddress"));
    assert.ok(j.examples.post && j.examples.get, "tell the caller both shapes");
    assert.equal(j.freeSample, "/dossier/sample");
  });

  test("a malformed address is rejected", async () => {
    assert.equal((await post("/dossier", { tokenAddress: "nope" })).status, 400);
  });

  test("an unsupported chain is rejected", async () => {
    assert.equal((await post("/dossier", { tokenAddress: ADDR.cake, chain: "bnb" })).status, 400);
  });

  test("parameters are accepted as a body or a query string, on either method", async () => {
    // Buyers' x402 clients replay differently; refusing one shape means a paid
    // caller gets a 400 and no report.
    for (const r of [
      await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc" }),
      await get(`/dossier?tokenAddress=${ADDR.cake}&chain=bsc`),
      await post(`/dossier?tokenAddress=${ADDR.cake}&chain=bsc`),
    ]) {
      assert.equal(r.status, 200);
    }
  });

  test("the body wins when both are present", async () => {
    const r = await app.request(`/dossier?tokenAddress=${ADDR.uni}&chain=ethereum&format=json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenAddress: ADDR.cake, chain: "bsc", format: "json" }),
    });
    const j = (await r.json()) as { token: { address: string } };
    assert.equal(j.token.address.toLowerCase(), ADDR.cake);
  });
});

describe("nothing is charged for what we cannot report on", () => {
  test("an address with no contract code is refused with 404, and says so", async () => {
    const r = await post("/dossier", { tokenAddress: ADDR.nowhere, chain: "bsc" });
    assert.equal(r.status, 404);
    const j = (await r.json()) as Record<string, unknown>;
    // Reading the chain gives the sharper answer: not "no market found" but
    // "there is nothing deployed at this address".
    assert.equal(j.error, "not_a_contract");
    assert.equal(j.charged, false);
    assert.match(String(j.hint), /no contract code/i);
  });

  test("a source outage returns 503 with Retry-After, not a verdict", async () => {
    restore();
    const r2 = stubUpstream({ fail: { goplus: "timeout", dexscreener: "timeout" } });
    const r = await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc" });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "30");
    r2();
    restore = stubUpstream();
  });

  test("every refusal is non-2xx, which is what makes it unchargeable", async () => {
    // The SDK settles only when the handler returns < 400. These are the paths
    // a buyer can reach with a bad or unanswerable request.
    for (const r of [
      await post("/dossier", {}),
      await post("/dossier", { tokenAddress: "nope" }),
      await post("/dossier", { tokenAddress: ADDR.nowhere, chain: "bsc" }),
    ]) {
      assert.ok(r.status >= 400, `expected a non-2xx, got ${r.status}`);
    }
  });
});

describe("coverage preflight", () => {
  test("names the chain among its sources", async () => {
    const j = (await (
      await get(`/dossier/preflight?tokenAddress=${ADDR.usdt0}&chain=xlayer`)
    ).json()) as Record<string, any>;
    assert.equal(j.sources.rpc, "ok");
    assert.ok(j.fieldsAvailable.includes("contractIdentity"));
  });

  test("an address with no code is flagged as unbuyable before paying", async () => {
    const j = (await (
      await get(`/dossier/preflight?tokenAddress=${ADDR.nowhere}&chain=bsc`)
    ).json()) as Record<string, any>;
    assert.equal(j.reportAvailable, false);
    assert.match(j.note, /no contract code/i);
  });

  test("reports coverage without giving away the verdict", async () => {
    const r = await get(`/dossier/preflight?tokenAddress=${ADDR.cake}&chain=bsc`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, unknown>;
    assert.equal(j.expectedCoverage, 1);
    assert.equal(j.reportAvailable, true);
    for (const leaked of ["verdict", "riskVerdict", "reasons", "maxSizeUsd", "checks", "security"]) {
      assert.ok(!(leaked in j), `preflight must not expose ${leaked}`);
    }
    assert.equal(/honeypot|proxy|renounce/i.test(JSON.stringify(j)), false);
  });

  test("partial coverage names the fields that will be missing", async () => {
    const j = (await (
      await get(`/dossier/preflight?tokenAddress=${ADDR.usdt0}&chain=xlayer`)
    ).json()) as Record<string, any>;
    assert.ok(j.expectedCoverage < 1);
    assert.ok(j.fieldsUnavailable.includes("liquidityUsd"));
    assert.ok(j.fieldsUnavailable.includes("priceUsd"));
    assert.match(j.note, /Partial coverage/);
  });

  test("it agrees with what the paid call then charges for", async () => {
    const pf = (await (
      await get(`/dossier/preflight?tokenAddress=${ADDR.cake}&chain=bsc`)
    ).json()) as Record<string, any>;
    const report = (await (
      await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc", format: "json" })
    ).json()) as { riskVerdict: { confidence: number } };
    assert.equal(pf.expectedCoverage, report.riskVerdict.confidence);
  });

  test("bad input is rejected the same way as the paid route", async () => {
    assert.equal((await get("/dossier/preflight")).status, 400);
    assert.equal((await get("/dossier/preflight?tokenAddress=nope")).status, 400);
  });
});

describe("recovery", () => {
  test("neither proof means 400, and no report", async () => {
    const r = await post("/dossier/recovery", {});
    assert.equal(r.status, 400);
    const j = (await r.json()) as Record<string, unknown>;
    assert.equal(j.error, "missing_proof_of_purchase");
    assert.equal("deliverable" in j, false);
  });

  test("a request hash alone is refused, because anyone can derive it", async () => {
    const hash = archive.paramsHash({ tokenAddress: ADDR.cake, chain: "bsc" });
    const r = await post("/dossier/recovery", { requestParamsSha256: hash });
    assert.equal(r.status, 400);
  });

  test("the settlement transaction returns the exact bytes delivered", async () => {
    const delivered = await (
      await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc" })
    ).text();
    // In dev-skip mode the SDK never settles, so link the transaction the way
    // the payment middleware would.
    const newest = archive.byHash(archive.paramsHash({ tokenAddress: ADDR.cake, chain: "bsc" }));
    assert.ok(newest, "the delivery should have been archived");
    archive.linkTransaction(newest!.id, "0xRECOVERTEST");
    const j = (await (
      await get("/dossier/recovery?transaction=0xRECOVERTEST")
    ).json()) as Record<string, any>;
    assert.equal(j.status, "recovered");
    assert.equal(j.deliverable, delivered, "byte-identical to what was delivered");
    assert.equal(j.agentId, 7012);
  });

  test("a transaction we never issued returns 404", async () => {
    assert.equal((await get("/dossier/recovery?transaction=0xdead")).status, 404);
  });

  // Job ids are handed out by the public marketplace: `task-search` returns
  // other agents' job ids, so accepting one as sole proof let anyone enumerate
  // them and read reports they never bought. One now has to arrive with the
  // request the buyer actually paid for.
  test("a job id on its own is refused, however well formed", async () => {
    for (const q of [
      "jobId=notajob",
      `jobId=0x${"a".repeat(64)}`,
      `jobId=0x${"0".repeat(63)}1`,
    ]) {
      const r = await get(`/dossier/recovery?${q}`);
      assert.equal(r.status, 400, `${q} must not be accepted on its own`);
      assert.equal((await r.json()).error, "insufficient_proof_of_purchase");
    }
  });

  test("the refusal names what to send, so a real buyer is not stranded", async () => {
    const j = await (await get(`/dossier/recovery?jobId=0x${"b".repeat(64)}`)).json();
    assert.match(j.message, /originalBody|requestParamsSha256/);
    assert.match(j.message, /paymentTransaction/);
  });

  // The settlement hash is not in the marketplace search and reaches only the
  // buyer, so it stays sufficient alone. Regressing this would strand everyone
  // who paid outside a task.
  test("a transaction alone still recovers, needing no second factor", async () => {
    const r = await get("/dossier/recovery?transaction=0xRECOVERTEST");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "recovered");
  });

  // The path the tightening could plausibly have broken, and the one our own
  // delivery message tells marketplace buyers to use. A buyer knows what they
  // asked about, so pairing the job id with the request has to keep working.
  test("a job id paired with the request still recovers the report", async () => {
    const body = { tokenAddress: ADDR.cake, chain: "bsc" };
    const delivered = await (await post("/dossier", body)).text();
    const rec = archive.byHash(archive.paramsHash(body));
    assert.ok(rec, "the delivery should have been archived");
    const jobId = `0x${"c".repeat(64)}`;
    archive.save({ ...rec!, jobId });

    const r = await post("/dossier/recovery", { jobId, originalBody: body });
    assert.equal(r.status, 200, "a buyer holding their own request must not be locked out");
    const j = (await r.json()) as Record<string, any>;
    assert.equal(j.status, "recovered");
    assert.equal(j.deliverable, delivered, "byte-identical to what was delivered");

    // The same job id with somebody else's request is still refused, so the
    // second factor is doing real work rather than being a formality.
    const wrong = await post("/dossier/recovery", {
      jobId,
      originalBody: { tokenAddress: ADDR.uni },
    });
    assert.equal(wrong.status, 403);
  });

  test("mismatched parameters alongside a valid proof are refused", async () => {
    const r = await post("/dossier/recovery", {
      transaction: "0xRECOVERTEST",
      originalBody: { tokenAddress: ADDR.uni },
    });
    assert.equal(r.status, 403);
  });
});

describe("independent verification", () => {
  test("the signing key is published at a well-known path", async () => {
    const r = await get("/.well-known/dossier-signing-key.json");
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, any>;
    assert.equal(j.issuer.agentId, 7012);
    assert.ok(j.schemaVersion);
    assert.ok(j.verifier.endsWith("/verify"));
  });

  test("the verifier page runs the check in the browser, not on our server", async () => {
    const r = await get("/verify");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("crypto.subtle.verify"), "verification must happen client-side");
    assert.ok(html.includes("Ed25519"));
    // If it posted the attestation back to us, it would be our claim again.
    assert.equal(/fetch\(["'][^"']*verify["']/.test(html), false);
  });

  test("a report carries a hash of exactly what produced it", async () => {
    const j = (await (
      await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc", format: "json" })
    ).json()) as Record<string, any>;
    const att = j.attestation;
    assert.ok(att, "every report should carry an attestation");
    assert.equal(att.payload.issuer.agentId, 7012);
    assert.equal(att.payload.token.address, ADDR.cake);
    assert.equal(att.payload.result.verdict, j.riskVerdict.verdict);
    assert.equal(att.payload.result.coverage, j.riskVerdict.confidence);
    const sources = att.payload.observations.map((o: any) => o.source);
    assert.ok(sources.includes("goplus"));
    assert.ok(sources.includes("dexscreener"));
    assert.ok(sources.some((s: string) => s.endsWith("-rpc")));
  });

  test("the attestation verifies with the published key", async () => {
    const j = (await (
      await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc", format: "json" })
    ).json()) as Record<string, any>;
    const key = (await (await get("/.well-known/dossier-signing-key.json")).json()) as any;
    const r = verifyAttestation(j.attestation, key.publicKey ?? undefined);
    if (key.publicKey) {
      assert.equal(r.verified, true, r.reason);
    } else {
      // No key configured in this environment: the hash must still be right.
      assert.equal(r.hashMatches, true);
    }
  });

  test("the html report shows the hash and points at the verifier", async () => {
    const html = await (
      await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc" })
    ).text();
    assert.ok(html.includes("Verification"));
    assert.ok(html.includes("Payload sha256"));
    assert.ok(html.includes("/verify"));
  });
});

describe("deliverables are named", () => {
  test("the response carries a filename a buyer can save", async () => {
    const r = await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc" });
    assert.match(r.headers.get("content-disposition") ?? "", /filename="dossier-.*\.html"/);
  });

  test("json format is named .json", async () => {
    const r = await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc", format: "json" });
    assert.match(r.headers.get("content-disposition") ?? "", /\.json"/);
  });
});

// HEAD is a payable method so that unpaid probes and OKX's validator still get a
// 402, but Hono dispatches it to the GET handler and HTTP then strips the body.
// A paid HEAD therefore ran every upstream source, built the report, archived it,
// and returned 200 with zero bytes — and 200 is what the SDK settles on. The
// caller was charged for nothing, which is the one thing this service promises
// never to do.
describe("HEAD on the paid route", () => {
  test("is refused rather than served, and cannot settle", async () => {
    const r = await app.request(`/dossier?tokenAddress=${ADDR.cake}&chain=bsc`, { method: "HEAD" });
    assert.equal(r.status, 405, "must not be a 2xx, or the payment settles");
    assert.equal(r.headers.get("allow"), "GET, POST");
  });

  test("does no work: no report is built and nothing is archived", async () => {
    const before = archive.byHash(archive.paramsHash({ tokenAddress: ADDR.uni, chain: "ethereum" }));
    await app.request(`/dossier?tokenAddress=${ADDR.uni}&chain=ethereum`, { method: "HEAD" });
    const after = archive.byHash(archive.paramsHash({ tokenAddress: ADDR.uni, chain: "ethereum" }));
    assert.equal(
      after?.id,
      before?.id,
      "a HEAD that archives a report has done the work and returned nothing",
    );
  });

  test("GET and POST are untouched", async () => {
    assert.equal((await get(`/dossier?tokenAddress=${ADDR.cake}&chain=bsc`)).status, 200);
    assert.equal((await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc" })).status, 200);
  });
});
