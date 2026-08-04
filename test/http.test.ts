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
import { verifyAttestation, canonicalJson, sha256 } from "../src/attest";
import { renderVerifyHtml } from "../src/verify-page";

const archiveSha = (o: unknown) => sha256(canonicalJson(o));

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;
// The internal bypass, which is how the fulfilment daemon fetches a task
// buyer's report, needs INTERNAL_KEY set before src/app is imported. Imports
// hoist above any assignment here, so `pnpm test` sets it instead.

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

  test("/health reports the fulfilment watcher's age, and nothing else about it", async () => {
    // Every other signal on this endpoint stays green with the watcher dead, so
    // a monitor outside the box had no way to see a stopped timer. The age is
    // null in the test environment, which has no heartbeat file — that is the
    // "not running" answer, and the monitor treats it as a failure.
    const j = (await (await get("/health")).json()) as Record<string, unknown>;
    assert.ok("fulfilmentAgeSeconds" in j, "a monitor cannot assert a field that is absent");
    assert.ok(
      j.fulfilmentAgeSeconds === null || typeof j.fulfilmentAgeSeconds === "number",
      "the age is a number or null, never a string or an object",
    );
    // The heartbeat file also records how many jobs were in flight. That is
    // business volume on an unauthenticated endpoint, not a monitoring signal.
    for (const leak of ["tasks", "candidates", "jobs"]) {
      assert.ok(!(leak in j), `/health must not publish ${leak}`);
    }
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
    assert.match(j.message, /recoveryCode/);
    assert.match(j.message, /paymentTransaction/);
  });

  // The settlement hash is not in the marketplace search and reaches only the
  // buyer, so it stays sufficient alone. Regressing this would strand everyone
  // who paid outside a task.
  test("a transaction alone still recovers, needing no second factor", async () => {
    const r = await get("/dossier/recovery?transaction=0xRECOVERTEST");
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, unknown>;
    assert.equal(j.status, "recovered");
    // And the response says plainly what that costs. Transfers to the payout
    // address are on-chain, so an observer can reach this report; a buyer is
    // told that on the response rather than only in a README they may not read.
    assert.match(String(j.confidentiality), /observable on-chain|not a confidentiality boundary/);
  });

  // Records written before per-report codes existed keep the parameter check.
  // Their buyers were never given a code and hold instructions naming the
  // request, so removing it would strand them; they expire with the archive
  // window.
  test("a job id paired with the request still recovers a pre-code report", async () => {
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

  // A random per-report code, delivered once in the buyer's message and stored
  // only as a hash. The parameters it replaces were guessable: "WBTC on
  // ethereum" is what most buyers of a WBTC report sent, so an enumerated job
  // id paired with the obvious request read a report nobody had bought.
  test("a task delivery mints a code, and only the daemon ever sees it", async () => {
    const jobId = `0x${"d".repeat(64)}`;
    const r = await app.request("/dossier", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": process.env.INTERNAL_KEY ?? "",
        "x-job-id": jobId,
      },
      body: JSON.stringify({ tokenAddress: ADDR.uni, chain: "ethereum", format: "json" }),
    });
    assert.equal(r.status, 200);
    const code = r.headers.get("x-recovery-code");
    assert.ok(code && /^[0-9a-f]{32}$/.test(code), "a 128-bit code goes back to the daemon");

    // Not in the report. The body is signed and archived, so a code written
    // there would be inside the very artefact it protects.
    assert.ok(!(await r.text()).includes(code!), "the code must not be in the deliverable");

    const rec = archive.byJobId(jobId);
    assert.ok(rec, "the delivery was archived");
    assert.ok(!JSON.stringify(rec).includes(code!), "and the code itself is never stored");
    assert.ok(rec!.recoveryCodeSha256, "only its hash is");

    // The code recovers it.
    const good = await post("/dossier/recovery", { jobId, recoveryCode: code });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).status, "recovered");
  });

  test("format=message returns the deliverable text, with its code inline", async () => {
    // The whole point: the sender receives a finished string. If it had to be
    // assembled from JSON by whoever is sending, that is where "safe position
    // size" came from.
    const jobId = `0x${"f".repeat(64)}`;
    const hdrs = {
      "content-type": "application/json",
      "x-internal-key": process.env.INTERNAL_KEY ?? "",
      "x-job-id": jobId,
    };
    // The real order, and the only one that yields a code: the report is
    // delivered first, then the message that describes it. A message for a job
    // with no delivered report has no record to attach a capability to, and
    // says so by printing the older instructions instead.
    await app.request("/dossier", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ tokenAddress: ADDR.uni, chain: "ethereum" }),
    });
    const r = await app.request("/dossier", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ tokenAddress: ADDR.uni, chain: "ethereum", format: "message" }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
    const text = await r.text();
    assert.match(text, /VERDICT:/);
    assert.match(text, /heuristic size cap/);
    assert.ok(!/safe position size/i.test(text));

    // The code quoted in the text is the one that actually recovers, not a
    // second code minted for the header.
    const code = text.match(/"recoveryCode":"([0-9a-f]{32})"/)?.[1];
    assert.ok(code, "the message must quote the code it tells the buyer to use");
    assert.equal(code, r.headers.get("x-recovery-code"));
    const back = await post("/dossier/recovery", { jobId, recoveryCode: code });
    assert.equal(back.status, 200, "the code printed in the message must work");
    // And it must return the report, not the message. Archiving the message as
    // its own record made it the newest one for the job, so recovery handed the
    // buyer back the text they were already holding: job 0xc4716819 recovered
    // 1095 bytes of message where its document should have been.
    const j = (await back.json()) as Record<string, any>;
    assert.equal(j.contentType, "text/html", "recovery must return the document");
    assert.ok(
      String(j.deliverable).includes("<html"),
      "a buyer recovering wants the report, not the message they already have",
    );
  });

  test("fetching the message does not displace the report it describes", async () => {
    const jobId = `0x${"1a".repeat(32)}`;
    const hdrs = {
      "content-type": "application/json",
      "x-internal-key": process.env.INTERNAL_KEY ?? "",
      "x-job-id": jobId,
    };
    const body = { tokenAddress: ADDR.cake, chain: "bsc" };
    // The real order: the report is fetched and uploaded, then the message.
    await app.request("/dossier", { method: "POST", headers: hdrs, body: JSON.stringify(body) });
    const before = archive.byJobId(jobId);
    assert.equal(before?.contentType, "text/html");

    await app.request("/dossier", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ ...body, format: "message" }),
    });
    const after = archive.byJobId(jobId);
    assert.equal(after?.id, before?.id, "the message must not become the job's deliverable");
    assert.equal(after?.contentType, "text/html");
    assert.ok(after?.recoveryCodeSha256, "and the code is filed against the report");
  });

  test("a coded report cannot be recovered by guessing the request", async () => {
    // The whole point of the change. This is the exact pair the audit called
    // out: a job id anyone can enumerate, plus the request anyone would guess.
    const jobId = `0x${"e".repeat(64)}`;
    const body = { tokenAddress: ADDR.uni, chain: "ethereum", format: "json" as const };
    await app.request("/dossier", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": process.env.INTERNAL_KEY ?? "",
        "x-job-id": jobId,
      },
      body: JSON.stringify(body),
    });

    const guessed = await post("/dossier/recovery", { jobId, originalBody: body });
    assert.equal(guessed.status, 403, "guessing the request must no longer be enough");
    assert.equal((await guessed.json()).error, "recovery_code_required");

    const wrongCode = await post("/dossier/recovery", { jobId, recoveryCode: "0".repeat(32) });
    assert.equal(wrongCode.status, 403);
    assert.equal((await wrongCode.json()).error, "recovery_code_mismatch");
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

// A buyer who omitted the chain got recovery instructions, and a report, that
// both named the chain we resolved. The archive indexed only the request as
// sent, so the exact command we printed for them returned 403.
describe("recovery accepts the request in the form the buyer has it", () => {
  test("the resolved chain proves ownership, not just the one that was sent", async () => {
    const sent = { tokenAddress: ADDR.cake };
    await post("/dossier", sent);
    const rec = archive.byHash(archive.paramsHash(sent));
    assert.ok(rec, "the delivery should be archived under the request as sent");
    const jobId = `0x${"d".repeat(64)}`;
    archive.save({ ...rec!, jobId });

    // What the buyer actually holds: the chain the report and our own
    // instructions name.
    const r = await post("/dossier/recovery", {
      jobId,
      originalBody: { tokenAddress: ADDR.cake, chain: rec!.request.chain ?? "bsc" },
    });
    assert.equal(r.status, 200, "the command we print must not 403");
  });

  test("the original form still works", async () => {
    const sent = { tokenAddress: ADDR.cake };
    const rec = archive.byHash(archive.paramsHash(sent));
    const jobId = `0x${"e".repeat(64)}`;
    archive.save({ ...rec!, jobId });
    const r = await post("/dossier/recovery", { jobId, originalBody: sent });
    assert.equal(r.status, 200);
  });

  test("a different token is still refused", async () => {
    const rec = archive.byHash(archive.paramsHash({ tokenAddress: ADDR.cake }));
    const jobId = `0x${"f".repeat(64)}`;
    archive.save({ ...rec!, jobId });
    const r = await post("/dossier/recovery", {
      jobId,
      originalBody: { tokenAddress: ADDR.uni },
    });
    assert.equal(r.status, 403);
  });
});

// The service shipped with none of these. It mattered most on /verify, which
// renders JSON an attacker chooses: a crafted ?attestation= link executed script
// on this origin and nothing constrained what it could do.
describe("security headers", () => {
  test("every response carries the baseline", async () => {
    for (const path of ["/", "/verify", "/health", "/info"]) {
      const h = (await get(path)).headers;
      assert.equal(h.get("x-content-type-options"), "nosniff", path);
      assert.equal(h.get("referrer-policy"), "no-referrer", path);
      assert.equal(h.get("x-frame-options"), "DENY", path);
      assert.ok(h.get("content-security-policy"), `${path} has no CSP`);
    }
  });

  test("JSON is allowed to execute nothing at all", async () => {
    const csp = (await get("/health")).headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.equal(csp.includes("script-src"), false, "a JSON response needs no script source");
  });

  test("the document policy allows our own scripts and no one else's", async () => {
    const csp = (await get("/verify")).headers.get("content-security-policy")!;
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;
    assert.ok(scriptSrc, "there must be a script-src directive");
    assert.match(scriptSrc, /'sha256-/);
    // Scoped to script-src on purpose: style-src carries 'unsafe-inline'
    // deliberately, because the page's styles are inline and ours. On scripts it
    // would hand back most of what removing innerHTML took away.
    assert.equal(scriptSrc.includes("unsafe-inline"), false, "script-src must not be opened up");
    assert.equal(/https?:/.test(scriptSrc), false, "no third-party script origin");
    assert.match(csp, /frame-ancestors 'none'/);
  });

  // A hash that does not match the bytes served silently breaks the page: the
  // script is simply refused and the verifier stops working.
  test("the allowed hash is the hash of the script actually served", async () => {
    const { createHash } = await import("node:crypto");
    for (const path of ["/", "/verify"]) {
      const r = await get(path);
      const body = await r.text();
      const inline = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      assert.ok(inline, `${path} should inline a script`);
      const want = `'sha256-${createHash("sha256").update(inline!, "utf8").digest("base64")}'`;
      assert.ok(
        r.headers.get("content-security-policy")!.includes(want),
        `${path} serves a script its own CSP would block`,
      );
    }
  });
});

// The signature has to commit to the report that was actually issued, not to a
// summary of it and not to some constant. Testing the hashing helper in
// isolation does not prove the report is wired to it.
describe("a delivered report is covered by its own signature", () => {
  test("the signed hash is the hash of the body that was sent", async () => {
    const r = await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc", format: "json" });
    assert.equal(r.status, 200);
    const { attestation, ...body } = (await r.json()) as Record<string, any>;
    assert.ok(attestation?.payload?.reportSha256, "the payload must commit to the body");
    assert.equal(
      archiveSha(body),
      attestation.payload.reportSha256,
      "the signature commits to something other than the report it came with",
    );
    // Signing is only configured when SIGNING_KEY is set; the suite runs without
    // one, so an unsigned report still carries the hash and says why it is
    // unsigned. Verify the signature only when there is one to verify.
    if (attestation.signature) {
      assert.equal(verifyAttestation(attestation as any).verified, true);
    } else {
      assert.ok(attestation.unsignedReason, "an unsigned report must say why");
      assert.ok(attestation.payloadSha256, "and must still carry its hashes");
    }
  });

  test("altering anything outside the old summary now breaks it", async () => {
    const r = await post("/dossier", { tokenAddress: ADDR.cake, chain: "bsc", format: "json" });
    const { attestation, ...body } = (await r.json()) as Record<string, any>;
    const signed = attestation.payload.reportSha256;
    // Every one of these was outside the signature before, and every one is
    // something a buyer acts on.
    const tampered = [
      { ...body, token: { ...body.token, liquidityUsd: 99_000_000 } },
      { ...body, token: { ...body.token, holderCount: 1 } },
      { ...body, security: { ...body.security, proxy: !body.security.proxy } },
      { ...body, security: { ...body.security, ownerRenounced: true } },
      { ...body, riskVerdict: { ...body.riskVerdict, reasons: ["nothing of concern"] } },
      { ...body, contract: { ...body.contract, owner: "0xdead" } },
    ];
    for (const t of tampered) {
      assert.notEqual(archiveSha(t), signed, `an altered report still matched: ${JSON.stringify(t).slice(0, 60)}`);
    }
  });

  test("the verifier actually recomputes it rather than trusting the payload", () => {
    const page = renderVerifyHtml("https://dossier.rouma.xyz");
    assert.match(page, /reportSha256/, "the verifier must know about the body hash");
    assert.match(page, /canonical\(reportBody\)/, "and must recompute it from the pasted report");
  });
});
