import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@okxweb3/x402-hono";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { decodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import {
  assertPaymentBypassAllowed,
  config,
  paymentConfigured,
} from "./config";
import { SourcesUnavailableError } from "./engine/engine";
import {
  DossierRequest,
  buildDossier,
  preflight,
  ChainNotFoundError,
  TokenNotFoundError,
  NotAContractError,
} from "./dossier/report";
import { renderDossierHtml } from "./dossier/render";
import { renderDeliveryMessage } from "./dossier/message";
import * as archive from "./dossier/archive";
import { renderSiteHtml } from "./site";
import { fontByPath } from "./fonts";
import { AVATAR_B64 } from "./generated/avatar-data";
import { publicKey, SCHEMA_VERSION, METHODOLOGY_VERSION } from "./attest";
import { renderVerifyHtml } from "./verify-page";
import * as ratelimit from "./ratelimit";
import * as reqlog from "./reqlog";
import {
  BASE_HEADERS,
  NON_DOCUMENT_CSP,
  documentCsp,
} from "./security-headers";
import { VERIFY_INLINE } from "./verify-page";
import { SITE_INLINE } from "./site";
import { dossierInputSchema, httpInputSchema } from "./x402-contract";
import {
  trackFacilitator,
  watchFacilitator,
  currentFacilitatorState,
  type Unreached,
} from "./x402-facilitator";
import {
  normalizeTimeoutRecoveryReceipt,
  validateSettlementReceipt,
} from "./settlement-receipt";
import * as paymentReplay from "./payment-replay";
import { runFacilitatorInitBurst, singleFlight } from "./facilitator-init";

// `app` is importable without the standalone production schema for unit tests
// and free previews, but the payment bypass itself is never importable in an
// unrecognised environment. This closes alternate-entry/import paths as well
// as the listener boundary enforced by server.ts.
assertPaymentBypassAllowed();

// Constant-time comparison for the payment-bypass secret. A `===` on a secret
// is a habit worth not having, even where a remote timing attack over TLS is
// impractical.
function internalKeyMatches(given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.internalKey);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const app = new Hono();

const PAYMENT_HEADER_MAX_BYTES = 16 * 1024;

function paymentHeader(c: {
  req: { header(name: string): string | undefined };
}): string | undefined {
  return c.req.header("payment-signature") || c.req.header("x-payment");
}

function durablePaymentRetry(header: string | undefined): boolean {
  if (
    !header ||
    Buffer.byteLength(header, "utf8") > PAYMENT_HEADER_MAX_BYTES
  ) {
    return false;
  }
  try {
    const payload = decodePaymentSignatureHeader(header);
    const fingerprint = paymentReplay.fingerprintPayment(
      payload,
      payload.accepted,
    );
    if (!fingerprint) return false;
    const existing = paymentReplay.existing(fingerprint);
    if (existing.kind !== "found") return false;
    const requirement = existing.state.requirements;
    const accepted = payload.accepted;
    return (
      accepted.scheme === requirement.scheme &&
      accepted.network === requirement.network &&
      accepted.amount === requirement.amount &&
      accepted.asset.toLowerCase() === requirement.asset.toLowerCase() &&
      accepted.payTo.toLowerCase() === requirement.payTo.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Whether the payment layer actually works, as opposed to being configured.
 *
 * Those are different things, and the difference hid a two-hour outage: the
 * credentials were present, so `paymentConfigured()` was true, while every paid
 * call answered 503 because the facilitator was rejecting them. Health has to
 * report the live state, not the intent.
 */
type PaymentLayer =
  "disabled" | "not_configured" | "connecting" | "ready" | "failing";
let paymentLayer: PaymentLayer = "connecting";
let facilitatorInitAttempts = 0;
let facilitatorLastAttemptAt: string | undefined;
let facilitatorLastSuccessAt: string | undefined;
let facilitatorLastFailureAt: string | undefined;
export function paymentLayerState(): PaymentLayer {
  return paymentLayer;
}

// One structured line per request, mounted first so it measures the whole chain
// including the payment middleware. It never throws and never touches the
// response: a log that can break a paid delivery is worse than no log.
app.use(async (c, next) => {
  const started = Date.now();
  try {
    await next();
  } finally {
    try {
      if (!reqlog.isNoise(c.req.path)) {
        const paid = Boolean(
          c.req.header("payment-signature") || c.req.header("x-payment"),
        );
        const line: reqlog.ReqLine = {
          m: c.req.method,
          p: c.req.path,
          s: c.res?.status ?? 0,
          ms: Date.now() - started,
          ...(paid ? { paid: true } : {}),
          // Present only when this process validated and durably linked a final
          // settlement. Absence means "not confirmed here", not necessarily
          // "nothing moved" — an outage or malformed facilitator response can
          // leave the on-chain outcome unknown.
          ...reqlog.linkedReceipt((c as any).get("confirmedSettlement")),
          ...((c as any).get("logToken")
            ? { token: (c as any).get("logToken") }
            : {}),
          ...((c as any).get("logChain")
            ? { chain: (c as any).get("logChain") }
            : {}),
          ...((c as any).get("archiveId")
            ? { report: (c as any).get("archiveId") }
            : {}),
          ...((c as any).get("logJob")
            ? { job: (c as any).get("logJob") }
            : {}),
        };
        console.log(reqlog.format(line));
      }
    } catch {
      /* logging must never disturb a response */
    }
  }
});

// Security headers on every response. The verifier renders JSON an attacker
// chooses, and until now nothing constrained what a page could do if something
// ever got through. The document policy allows our two inline scripts by hash;
// everything else, including all JSON, is allowed to execute nothing at all.
const DOCUMENT_CSP = documentCsp([SITE_INLINE, VERIFY_INLINE]);
app.use(async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(BASE_HEADERS)) c.header(k, v);
  const type = c.res.headers.get("content-type") ?? "";
  c.header(
    "Content-Security-Policy",
    type.includes("text/html") ? DOCUMENT_CSP : NON_DOCUMENT_CSP,
  );
});

// Rate limiting for unauthenticated work. A payment header is not proof of
// payment: a new or malformed authorization remains attacker-controlled and
// consumes the public `/dossier` budget. Only an exact authorization that maps
// to already-authenticated durable replay state can bypass the limiter and
// reach reconciliation after its buyer may have paid.
const FREE_LIMITED = new Set([
  "/dossier",
  "/verify",
  "/dossier/recovery",
  "/dossier/sample",
  "/dossier/preflight",
  "/",
  "/info",
  "/health",
]);
app.use(async (c, next) => {
  const path = c.req.path;
  if (!FREE_LIMITED.has(path)) return next();
  const authorization = path === "/dossier" ? paymentHeader(c) : undefined;
  if (
    authorization &&
    Buffer.byteLength(authorization, "utf8") > PAYMENT_HEADER_MAX_BYTES
  ) {
    return c.json(
      {
        error: "payment_header_too_large",
        message: "Payment authorization headers must not exceed 16 KiB.",
      },
      431,
    );
  }
  if (
    path === "/dossier" &&
    ((config.internalKey &&
      internalKeyMatches(c.req.header("x-internal-key"))) ||
      durablePaymentRetry(authorization))
  ) {
    return next();
  }
  const key = ratelimit.clientKey(c.req.raw.headers);
  const d = ratelimit.check(path, key);
  if (!d.limited) return next();
  const observing = ratelimit.mode() === "observe";
  // Enforcing silently would mean a throttled buyer, or a throttled OKX
  // validator, leaves no trace at all — the one thing we would need to know.
  if (ratelimit.worthLogging(d)) {
    console.warn(
      `[ratelimit] ${observing ? "would block" : "blocked"} ${path} for ${key} ` +
        `(${d.limit}/min exceeded, ${d.overBy} over)`,
    );
  }
  if (observing) return next();
  c.header("Retry-After", String(d.retryAfterSec));
  return c.json(
    {
      error: "rate_limited",
      message: `Too many requests for ${path}. Retry shortly.`,
    },
    429,
  );
});

// `X-PAYMENT` is the header name in the original x402 spec; OKX's protocol uses
// `PAYMENT-SIGNATURE`. A generic x402 client sends the first, and this service
// advertises itself as an x402 service at a public URL, so both arrive.
//
// The SDK looks like it accepts either — its Hono adapter builds a context with
// `getHeader("payment-signature") || getHeader("x-payment")` — but that field is
// never read: `requiresPayment` only asks whether the route is priced, and
// `extractPayment` reads `payment-signature` alone. So a buyer who signs a
// payment and sends it under the spec's own name is answered as though they had
// not paid at all, and gets a challenge back for a payment they already made.
//
// This is the same failure this service already shipped once, when a paid caller
// replaying with GET and a query string was answered 400 because only a POST
// body was read. Nothing settles on that path, so nobody is charged, but they
// get no report and every reason to conclude the service is broken.
//
// Normalised here rather than handled downstream, so exactly one name reaches
// the payment layer and the alias cannot diverge from it. It widens who can pay
// us and weakens nothing: the payload still goes to the facilitator, which is
// what decides whether it is a real payment.
app.use(async (c, next) => {
  const alias = c.req.header("x-payment");
  if (alias && !c.req.header("payment-signature")) {
    c.req.raw.headers.set("payment-signature", alias);
  }
  return next();
});

// Our own fulfilment daemon identifies itself with a shared secret. Resolved
// once, here, so the payment bypass and the job-id capture below cannot drift
// apart in what they consider an internal call.
app.use(async (c, next) => {
  if (
    config.internalKey &&
    internalKeyMatches(c.req.header("x-internal-key"))
  ) {
    (c as any).set("internal", true);
  }
  return next();
});

/**
 * Marketplace job this delivery belongs to, when our daemon is the caller.
 *
 * Trusted only from the daemon: a buyer who could stamp someone else's job id
 * onto their own record would shadow that job's real deliverable in the index,
 * and the rightful buyer would recover the wrong report.
 */
function internalJobId(c: any): string | undefined {
  if (!c.get("internal")) return undefined;
  const j = String(c.req.header("x-job-id") || "").trim();
  return /^0x[a-f0-9]{64}$/i.test(j) ? j : undefined;
}

// Human landing page at the root; the same information stays machine-readable
// at /info for agents and crawlers that want structure rather than markup.
app.get("/", (c) =>
  c.html(renderSiteHtml({ price: config.dossierPrice, agentId: 7012 })),
);

// Self-hosted webfonts for the landing page, served from the bundle. Content
// hashed in the filename, so they can be cached forever. Not rate limited: the
// limiter only touches FREE_LIMITED paths, and these are static bytes already
// in memory.
app.get("/f/:file", (c) => {
  const f = fontByPath(c.req.path);
  if (!f) return c.notFound();
  c.header("Content-Type", "font/woff2");
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.body(new Uint8Array(f.body));
});

// The listing avatar. `agent update --picture` takes a URL rather than an
// upload, so the marketplace needs somewhere to fetch this from; serving it here
// keeps it on an origin we control instead of a third-party image host.
//
// Deliberately not content-hashed, unlike the fonts: a profile picture URL is
// handed to OKX once and stored, so it has to stay valid across deploys. Cached
// for a day rather than forever, so replacing the image does not require a new
// URL and another listing edit.
const AVATAR = Buffer.from(AVATAR_B64, "base64");
app.get("/avatar.png", (c) => {
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(new Uint8Array(AVATAR));
});

// The signing key, published so a report can be checked against a key fetched
// from a place the reader chooses, rather than the one bundled in the report.
app.get("/.well-known/dossier-signing-key.json", (c) => {
  const k = publicKey();
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    issuer: { agentId: 7012, name: "Dossier" },
    schemaVersion: SCHEMA_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    ...(k ?? {
      algorithm: null,
      publicKey: null,
      note: "This instance is not signing reports.",
    }),
    verifier: `${config.publicOrigin}/verify`,
  });
});

// Public verifier. Checks run in the visitor's browser; the server only serves
// the page. See src/verify-page.ts for why that distinction matters.
app.get("/verify", (c) => c.html(renderVerifyHtml(config.publicOrigin)));

app.get("/info", (c) =>
  c.json({
    service: "Dossier",
    agentId: 7012,
    description:
      "One paid call returns a polished, executive-ready due-diligence report on any token: risk verdict, a heuristic position-size cap, security flags, liquidity, and holder distribution, compiled deterministically from live data and rendered as a self-contained document.",
    endpoints: [
      {
        path: "/dossier",
        method: "POST",
        pricing: `${config.dossierPrice} per call (x402, USD₮0 on X Layer)`,
        body: {
          tokenAddress: "0x…",
          chain: "(optional — auto-detected when unambiguous)",
          format: "html | json",
        },
      },
      {
        path: "/dossier/sample",
        method: "GET",
        pricing: "free",
        description:
          "A real sample report, so you can see the deliverable before paying.",
      },
      {
        path: "/dossier/preflight",
        method: "GET or POST",
        pricing: "free",
        body: { tokenAddress: "0x…", chain: "(optional)" },
        description:
          "Coverage check for a specific token before paying: which data sources have it, expected coverage, which fields the report will contain, and whether it can be produced at all.",
      },
    ],
  }),
);

// NOTE: /dossier must NEVER answer an unpaid request with 2xx on
// ANY method. x402 validators (including OKX's `agent x402-check`, which probes
// with GET) treat a 200 as "not a valid x402 service" and reject the listing.
// Usage information lives on `/` and the free `/dossier/sample` instead; the
// paid paths are gated for GET and POST alike below.

// Free sample report on a well-known token, cached in-instance so repeat views
// don't burn free-API quota. Lets buyers and reviewers see the asset up front.
const SAMPLE = {
  chain: "bsc",
  tokenAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
} as const; // CAKE
const SAMPLE_TTL_MS = 6 * 60 * 60 * 1000;
let sampleCache: { html: string; json: string; at: number } | undefined;

/**
 * The sample, free, in either rendering: `?format=json` for machines.
 *
 * Both renderings come out of one build and are cached together, so the JSON is
 * not merely a similar report to the HTML, it is the same document: same report
 * id, same payload hash, same signature.
 *
 * The JSON exists so the attestation can be checked without a credential. It
 * carries the per-source response hashes, which the HTML does not print, and
 * those are what prove a report is re-checkable against the bytes its sources
 * actually returned. The alternative was giving CI the payment-bypass key, which
 * would have handed a monitoring job the authority to mint signed reports and to
 * stamp job ids onto other buyers' recovery records. A free surface that answers
 * the same question needs no secret to leak.
 */
app.get("/dossier/sample", async (c) => {
  const wantJson = c.req.query("format") === "json";
  const send = () =>
    wantJson
      ? c.body(sampleCache!.json, 200, {
          "content-type": "application/json; charset=UTF-8",
        })
      : c.html(sampleCache!.html);
  if (!sampleCache || Date.now() - sampleCache.at > SAMPLE_TTL_MS) {
    try {
      const dossier = await buildDossier({ ...SAMPLE, format: "html" });
      sampleCache = {
        html: renderDossierHtml(dossier, {
          banner:
            // Derived from config rather than written out, so a price change
            // cannot leave the sample advertising a figure we no longer charge.
            `Sample report (free). Every paid call to POST /dossier returns this document for the token you choose. ${config.dossierPrice.replace(/^\$/, "")} USD₮0 per call over x402 on X Layer · OKX.AI agent #7012.`,
        }),
        json: JSON.stringify(dossier),
        at: Date.now(),
      };
    } catch (e) {
      if (sampleCache) return send(); // serve stale over failing
      if (e instanceof SourcesUnavailableError) {
        c.header("Retry-After", "30");
        return c.json(
          { error: "data sources temporarily unavailable — retry shortly" },
          503,
        );
      }
      throw e;
    }
  }
  return send();
});

// Coverage preflight, free: what the paid report will and will not contain for
// this token, so nobody pays to discover that a token has no market data.
// It returns coverage and field availability only, never the verdict or any
// security flag — otherwise the free route would replace the paid one.
app.on(["GET", "POST"], "/dossier/preflight", async (c) => {
  const parsed = DossierRequest.safeParse(await readParams(c));
  if (!parsed.success) return invalid(c, parsed.error.issues);
  try {
    const p = await preflight(parsed.data);
    return c.json({
      ...p,
      price: config.dossierPrice,
      paidEndpoint: `${config.publicOrigin}/dossier`,
    });
  } catch (e) {
    if (e instanceof ChainNotFoundError) {
      return c.json(
        {
          error: "chain_not_found",
          message: e.message,
          reportAvailable: false,
        },
        404,
      );
    }
    if (e instanceof SourcesUnavailableError) {
      c.header("Retry-After", "30");
      return c.json(
        { error: "data sources temporarily unavailable — retry shortly" },
        503,
      );
    }
    throw e;
  }
});

// Recovery: a buyer who lost the paid response can fetch it again. Free —
// they have already paid — but it requires something they hold only because
// they bought: the settlement transaction for an x402 call, or the marketplace
// job id for a task-level purchase, whose reports our daemon delivers with no
// transaction to key on. Supplying the original parameters (or their hash) is
// accepted as a second check and returns the same archived bytes.
app.on(["GET", "POST"], "/dossier/recovery", async (c) => {
  const p = await readParams(c);
  const tx = String(p.paymentTransaction || p.transaction || "").trim();
  const jobId = String(p.jobId || p.job || "").trim();
  const givenHash = String(
    p.requestParamsSha256 || p.requestBodySha256 || "",
  ).trim();
  const code = String(p.recoveryCode || p.code || "").trim();
  let originalBody = p.originalBody as Record<string, unknown> | undefined;
  if (typeof originalBody === "string") {
    try {
      originalBody = JSON.parse(originalBody);
    } catch {
      originalBody = undefined;
    }
  }

  // One of the two proofs is required, and deliberately so. The request
  // parameters hash to a value anyone could derive for a popular token, so
  // accepting that alone would hand a paid report to someone who never bought
  // one.
  if (!tx && !jobId) {
    return c.json(
      {
        error: "missing_proof_of_purchase",
        message:
          "Send paymentTransaction: the settlement transaction hash from your paid call, " +
          "found in the PAYMENT-RESPONSE header of the response you received. " +
          "If you bought through a marketplace task instead, send jobId together with " +
          "originalBody or requestParamsSha256.",
        usage: {
          post: 'POST /dossier/recovery {"paymentTransaction":"0x…"}  or  {"jobId":"0x…","originalBody":{"tokenAddress":"0x…"}}',
          get: "GET /dossier/recovery?paymentTransaction=0x…  or  ?jobId=0x…&requestParamsSha256=…",
        },
      },
      400,
    );
  }

  if (tx && !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    return c.json(
      {
        error: "invalid_payment_transaction",
        message: "paymentTransaction must be the 32-byte on-chain transaction hash from PAYMENT-RESPONSE.",
      },
      400,
    );
  }

  const hash =
    givenHash || (originalBody ? archive.paramsHash(originalBody) : "");

  // A job id is not proof of purchase. The public marketplace hands them out:
  // `task-search` returns other agents' job ids, so anyone can enumerate them,
  // replay them here, and read reports they never paid for. A settlement
  // transaction is different, since it is not in that search and reaches only
  // the buyer, in their PAYMENT-RESPONSE header.
  //
  // So a job id has to be accompanied by something the buyer knows and an
  // enumerator does not: what they actually asked about. Our own delivery
  // message carries the contract and chain in the same text that points here,
  // so a genuine buyer is already holding it.
  //
  // The parameters were only ever a bar, not a wall: "WBTC on ethereum" is what
  // most buyers of a WBTC report sent, so an enumerated job id paired with the
  // obvious request still read someone else's report. Deliveries now carry a
  // random per-report code instead, handed to the buyer in the delivery message
  // and stored here only as a hash.
  //
  // Records written before that keep the parameter check, because their buyers
  // were never given a code and hold instructions that name the request. Those
  // expire with the 90-day archive window.
  if (!tx && !hash && !code) {
    return c.json(
      {
        error: "insufficient_proof_of_purchase",
        message:
          "A jobId on its own is not proof of purchase: job ids are publicly enumerable. " +
          "Send it together with recoveryCode, the code printed in the delivery message " +
          "that pointed you here, or send paymentTransaction instead, which needs nothing " +
          "else.",
        usage: {
          post: 'POST /dossier/recovery {"jobId":"0x…","recoveryCode":"…"}',
          alternative: 'POST /dossier/recovery {"paymentTransaction":"0x…"}',
        },
      },
      400,
    );
  }
  // The transaction is the stronger proof, so it decides when both are sent;
  // falling back to the job id could otherwise answer a mismatched pair.
  const rec = tx ? archive.byTransaction(tx) : archive.byJobId(jobId);

  if (!rec) {
    return c.json(
      {
        error: "not_found_in_archive",
        message:
          "No delivered report matches that transaction, job, or request. If the paid call " +
          "never reached this service, no report was produced and no payment was settled.",
        archiveWindowDays: 90,
      },
      404,
    );
  }
  // Job-id recovery, once the record is in hand. A record that carries a code
  // is proved with the code and with nothing else: accepting the parameters as
  // an alternative would leave the guessable path open beside the closed one,
  // which is not a fix.
  if (!tx && rec.recoveryCodeSha256) {
    if (!code || !archive.recoveryCodeMatches(rec, code)) {
      return c.json(
        {
          error: code ? "recovery_code_mismatch" : "recovery_code_required",
          message:
            "This report is recovered with the recovery code from its delivery message, " +
            "paired with the jobId. The request parameters are not accepted as proof for " +
            "this report because they are guessable for a popular token.",
        },
        403,
      );
    }
  }
  // If the caller also supplied the request, it must be the one that was paid
  // for, in either the form they sent or the form we resolved and printed back
  // to them.
  if (hash && rec.paramsSha256 !== hash && rec.resolvedParamsSha256 !== hash) {
    return c.json(
      {
        error: "proof_mismatch",
        message: "That transaction did not pay for those request parameters.",
      },
      403,
    );
  }

  return c.json({
    status: "recovered",
    service: "Token Due-Diligence Report",
    agentId: 7012,
    paymentTransaction: rec.paymentTransaction || null,
    jobId: rec.jobId || null,
    requestParamsSha256: rec.paramsSha256,
    request: rec.request,
    deliveredAt: rec.deliveredAt,
    recoveredAt: new Date().toISOString(),
    contentType: rec.contentType,
    deliverable: parseArchived(rec),
    // The settlement transaction above is asserted by this server, not covered
    // by the report's signature: a report is issued before its payment settles.
    signatureCovers:
      "the report's own findings, inputs and source observations — not the payment transaction",
    verifier: `${config.publicOrigin}/verify`,
    // Said here, on the response itself, rather than only in a README a buyer
    // may never read. A settlement transaction is enough on its own, and
    // transfers to our payout address are visible on-chain, so an observer who
    // watches them can reach a report. Requiring a per-report code here too
    // would be worse than the leak: the code travels in the response, and a
    // buyer who still holds the response does not need recovery. Their
    // transaction hash is what survives losing it, and it is in their wallet.
    // What that observer reaches is a report on a token somebody else chose,
    // built from free public data, of which a full sample is published.
    confidentiality:
      rec.paymentTransaction && !rec.recoveryCodeSha256
        ? "This report is recoverable by anyone holding its settlement transaction hash, " +
          "which is observable on-chain. Recovery is a guard against casual free reports, " +
          "not a confidentiality boundary. Treat the contents as readable by anyone " +
          "watching payments to this service."
        : "This report is recoverable only with the recovery code from its delivery message.",
  });
});

function parseArchived(rec: archive.ArchiveRecord): unknown {
  // A record could be truncated by a disk problem; return it as text rather
  // than failing a recovery the buyer already paid for.
  if (rec.contentType !== "application/json") return rec.deliverable;
  try {
    return JSON.parse(rec.deliverable);
  } catch {
    return rec.deliverable;
  }
}

// Stays 200 while the process is serving, even if payments are down: the free
// surface is unaffected and killing a healthy process would make things worse.
// The paid path is monitored separately, by asking it for a 402.
/**
 * How long ago the fulfilment watcher last completed a tick, in seconds.
 *
 * The watcher answers buyers' questions and delivers reports on task-mode jobs.
 * Nothing outside the box could see whether it was still running: every check
 * here — the site, the payment challenge, the signing key, the certificate —
 * stays green with the timer dead since the last reboot, which is exactly the
 * failure that would silently strand every task buyer.
 *
 * The count of jobs in flight is deliberately not published: that is our
 * business volume, not a monitoring signal. Two things about them are.
 */
function fulfilment(): {
  ageSeconds: number | null;
  oldestOpenSeconds: number | null;
  inboxMismatch: boolean;
} {
  try {
    const raw = readFileSync(
      join(homedir(), ".okx-agent-task", "fulfill-watcher-heartbeat.json"),
      "utf8",
    );
    const beat = JSON.parse(raw);
    const at = beat?.at;
    const oldest = beat?.oldestOpenSeconds;
    return {
      ageSeconds:
        typeof at === "number" && Number.isFinite(at)
          ? Math.max(0, Math.round(Date.now() / 1000 - at))
          : null,
      // How long the longest-outstanding job has been outstanding. A watcher
      // that is alive and one that has a job wedged in "asked, waiting for a
      // reply it cannot read" are indistinguishable from the age alone: both
      // tick every 120s forever. That is the shape the 2026-08-03 deadlock
      // took, and it was found by reading the state file on the box, which is
      // not a monitoring strategy. Volume is private; a stall is not, because a
      // stalled job is a buyer who paid and is waiting.
      oldestOpenSeconds:
        typeof oldest === "number" && Number.isFinite(oldest) ? oldest : null,
      // The watcher decides which messages in a conversation are the buyer's by
      // comparing against a cached inbox id. If that id ever stops matching
      // what the conversations say, replies get misattributed, and the failure
      // is otherwise completely silent.
      inboxMismatch: beat?.inboxMismatch === true,
    };
  } catch {
    return { ageSeconds: null, oldestOpenSeconds: null, inboxMismatch: false };
  }
}

const DURABILITY_INTEGRITY_TTL_MS = 30_000;
let durabilityHealthCache:
  | {
      at: number;
      version: string;
      archive: archive.ArchiveReadiness;
      replayReady: boolean;
    }
  | undefined;

function durabilityHealth(): {
  archive: archive.ArchiveReadiness;
  replayReady: boolean;
} {
  const version = archive.readinessVersion();
  if (
    !version ||
    !durabilityHealthCache ||
    durabilityHealthCache.version !== version ||
    Date.now() - durabilityHealthCache.at >= DURABILITY_INTEGRITY_TTL_MS
  ) {
    const archiveState = archive.readiness();
    const replayReady = paymentReplay.ready();
    // Both full scans create and remove durability probes in the archive
    // directory. Capture the version afterwards so those probes do not make
    // the next request invalidate the cache it just populated.
    const scannedVersion = archive.readinessVersion();
    durabilityHealthCache = {
      at: Date.now(),
      version: scannedVersion ?? `unavailable-${Date.now()}`,
      archive: archiveState,
      replayReady,
    };
  }
  return durabilityHealthCache;
}

function archiveReadyForExternalPayments(state: archive.ArchiveReadiness): boolean {
  return (
    state.ready &&
    state.mode === "strict" &&
    state.unsignedRecords === 0 &&
    Boolean(process.env.ARCHIVE_MAC_KEY) &&
    process.env.ARCHIVE_MAC_REQUIRED === "1"
  );
}

function healthSnapshot() {
  const durability = durabilityHealth();
  const archiveState = durability.archive;
  const replayReady = durability.replayReady;
  const paidReady =
    (config.devSkipPayment || paymentLayer === "ready") &&
    (config.devSkipPayment
      ? archiveState.ready
      : archiveReadyForExternalPayments(archiveState)) &&
    replayReady;
  return {
    // Liveness means the process can answer. Readiness is deliberately
    // stricter: a supervisor must not infer that paid traffic is safe merely
    // because the landing page is still alive during a facilitator outage.
    live: true,
    ready: paidReady,
    ok: true, // Backward-compatible liveness alias for existing monitors.
    ...(() => {
      const f = fulfilment();
      return {
        fulfilmentAgeSeconds: f.ageSeconds,
        oldestOpenJobSeconds: f.oldestOpenSeconds,
        inboxMismatch: f.inboxMismatch,
      };
    })(),
    devSkipPayment: config.devSkipPayment,
    paymentConfigured: paymentConfigured(),
    paymentLayer: paymentLayer,
    paidReady,
    facilitatorInitAttempts,
    ...(facilitatorLastAttemptAt ? { facilitatorLastAttemptAt } : {}),
    ...(facilitatorLastSuccessAt ? { facilitatorLastSuccessAt } : {}),
    ...(facilitatorLastFailureAt ? { facilitatorLastFailureAt } : {}),
    archiveReady: archiveState.ready,
    archiveMode: archiveState.mode,
    archiveUnsignedRecords: archiveState.unsignedRecords,
    ...(archiveState.reason ? { archiveReadinessReason: archiveState.reason } : {}),
    archiveMacRequired: process.env.ARCHIVE_MAC_REQUIRED === "1",
    archiveMacConfigured: Boolean(process.env.ARCHIVE_MAC_KEY),
    paymentReplayReady: replayReady,
    signing: publicKey() ? "enabled" : "unsigned",
    // Published so a monitor can assert it. The limiter ran in whichever mode an
    // env var happened to select, and nothing anywhere said which, so a deploy
    // that lost the variable throttled nobody and looked identical from outside.
    rateLimit: ratelimit.mode(),
  };
}

// Liveness remains 200 while paid dependencies recover, so systemd or a load
// balancer does not turn an upstream outage into a restart storm.
app.get("/health", (c) => c.json(healthSnapshot()));
app.get("/health/live", (c) => c.json({ live: true, ok: true }));

// Readiness has HTTP semantics as well as a JSON field: 503 means this instance
// must not receive a new payment. Free/recovery routes remain available.
app.get("/health/ready", (c) => {
  const health = healthSnapshot();
  return c.json(health, health.ready ? 200 : 503);
});

/**
 * What we say when the facilitator gave us no answer.
 *
 * Two different truths, and they must not be collapsed into one sentence.
 *
 * A verify that never landed means we do not know whether the payment is good,
 * and nothing was taken: no settle call was ever made. The buyer can retry
 * freely.
 *
 * A settle that never landed is worse and rarer. The payment was verified, the
 * report was built, and our instruction to move the money went out into
 * silence. It may have settled. Telling that buyer "Payment Required" is how
 * you get paid twice by an obliging client, so this says the state is unknown
 * and points them at the one thing that makes a retry safe: the authorization
 * they already signed carries a nonce, and a nonce cannot be spent twice.
 */
const unreachable = (unreached: Unreached): Response => {
  console.error(
    "[x402] facilitator gave no answer:",
    unreached.settle ? `settle: ${unreached.settle}` : `verify: ${unreached.verify}`,
  );
  const body = unreached.settle
    ? {
        error: "settlement_unconfirmed",
        message:
          "Your payment was verified, but we could not reach the payment facilitator to " +
          "confirm settlement, so we do not know whether it completed. This is not a " +
          "refusal of your payment, and no report has been delivered. Retry with the same " +
          "signed payment rather than signing a new one: the authorization you already " +
          "sent carries a nonce, so it cannot be settled twice.",
        charged: "unknown",
        retryAfterSeconds: 60,
        ...(unreached.replay?.reconciliationId
          ? { reconciliationId: unreached.replay.reconciliationId }
          : {}),
      }
    : {
        error: "payment_layer_unreachable",
        message:
          "We could not reach the payment facilitator to check your payment, so we cannot " +
          "say whether it is valid. This is not a refusal. Nothing was settled, you have " +
          "not been charged, and no report was produced. Retry shortly.",
        charged: false,
        retryAfterSeconds: 60,
      };
  // Built by hand rather than through `c.json`, and carrying no header from the
  // response it replaces. The 402 it supersedes has either a PAYMENT-REQUIRED
  // challenge on it or a settlement receipt reporting a definite failure, and
  // both contradict what this response says. Hono's `c.res` setter copies every
  // header from the old response onto the new one, so the old one has to be
  // cleared first — see `honest` below.
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });
};

function replayPendingResponse(unreached: Unreached): Response {
  return new Response(
    JSON.stringify({
      error: "payment_reconciliation_pending",
      charged: "unknown",
      message:
        "This exact signed payment already has an unresolved settlement attempt. No new verification, report generation, or settlement was attempted. Retry the same signed payment after reconciliation; do not authorize a new one.",
      retryAfterSeconds: 60,
      ...(unreached.replay?.reconciliationId
        ? { reconciliationId: unreached.replay.reconciliationId }
        : {}),
    }),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "60" },
    },
  );
}

function settlementStateIsDefiniteFailure(unreached: Unreached): boolean {
  const answer = unreached.settlementAnswer;
  if (!answer || answer.success !== false) return false;
  // A timeout or pending response may have moved funds even when the direct
  // settle call did not return a final answer; retain the staged report for
  // reconciliation regardless of the response's success flag.
  return answer.status !== "timeout" && answer.status !== "pending";
}

/**
 * Preserve the bounded identity from a direct non-final settle answer for
 * later reconciliation, but only after checking it against the requirement
 * and verified payer that this request already established. A timeout or
 * pending answer is still not confirmation; this merely prevents the only
 * transaction lead from being discarded when the SDK's status poll is
 * unavailable or contradictory.
 */
function candidateSettlementEvidence(
  unreached: Unreached | undefined,
): paymentReplay.ReplaySettlement | undefined {
  const direct = unreached?.settlementAnswer;
  const expected = unreached?.settlementExpected;
  if (
    !(
      (direct?.success === false && direct.status === "timeout") ||
      direct?.status === "pending"
    ) ||
    !direct.transaction ||
    !/^0x[0-9a-fA-F]{64}$/.test(direct.transaction) ||
    !direct.network ||
    expected?.scheme !== "exact" ||
    !expected.network ||
    !expected.amount ||
    direct.network !== expected.network ||
    (direct.amount !== undefined && direct.amount !== expected.amount) ||
    (direct.payer !== undefined &&
      (!/^0x[0-9a-fA-F]{40}$/.test(direct.payer) ||
        (unreached?.verifiedPayer !== undefined &&
          direct.payer.toLowerCase() !== unreached.verifiedPayer.toLowerCase())))
  ) {
    return undefined;
  }
  return {
    transaction: direct.transaction,
    network: direct.network,
    // Exact settlement fixes the amount in the signed requirement even when
    // the facilitator omits it from its response.
    amount: expected.amount,
    ...(unreached?.verifiedPayer !== undefined
      ? { payer: unreached.verifiedPayer }
      : direct.payer !== undefined
        ? { payer: direct.payer }
        : {}),
  };
}

function replayRequestIdentity(params: Record<string, unknown>): paymentReplay.ReplayRequestIdentity {
  const parsed = DossierRequest.safeParse(params);
  if (!parsed.success || parsed.data.format === "message") {
    return {
      paramsSha256: archive.paramsHash(params),
      contentType: "invalid",
    };
  }
  return {
    paramsSha256: archive.paramsHash(parsed.data as Record<string, unknown>),
    contentType: parsed.data.format === "json" ? "application/json" : "text/html",
  };
}

function replaySameDelivery(
  request: paymentReplay.ReplayRequestIdentity,
  owner: archive.ArchiveRecord,
): boolean {
  if (request.contentType === "invalid" || request.contentType !== owner.contentType) {
    return false;
  }
  return [owner.paramsSha256, owner.resolvedParamsSha256]
    .filter((value): value is string => Boolean(value))
    .includes(request.paramsSha256);
}

function replayReceiptHeader(settlement: paymentReplay.ReplaySettlement): string {
  return Buffer.from(
    JSON.stringify({ success: true, status: "success", ...settlement }),
    "utf8",
  ).toString("base64");
}

function replaySettlementFromArchive(
  settlement: archive.ArchiveRecord["settlement"] | undefined,
): paymentReplay.ReplaySettlement | null {
  if (
    settlement?.status !== "confirmed" ||
    !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ||
    !settlement.network
  ) {
    return null;
  }
  return {
    transaction: settlement.transaction,
    network: settlement.network,
    ...(settlement.amount !== undefined ? { amount: settlement.amount } : {}),
    ...(settlement.payer !== undefined ? { payer: settlement.payer } : {}),
  };
}

function replaySettlementMatches(
  left: paymentReplay.ReplaySettlement,
  right: paymentReplay.ReplaySettlement,
): boolean {
  return (
    left.transaction.toLowerCase() === right.transaction.toLowerCase() &&
    left.network === right.network &&
    (left.amount ?? undefined) === (right.amount ?? undefined) &&
    (left.payer?.toLowerCase() ?? undefined) ===
      (right.payer?.toLowerCase() ?? undefined)
  );
}

/**
 * A timeout receipt only gives us a transaction lead.  On an exact retry we
 * may promote that lead to a settlement proof after a fresh facilitator status
 * query, but only when the query independently confirms every identity field
 * that matters to this purchase.  In particular, a status response for a
 * different transaction or network must never turn a candidate into an owner.
 */
function confirmedSettlementFromStatus(
  candidate: paymentReplay.ReplaySettlement,
  answer: unknown,
  requirements: paymentReplay.ReplayRequirements,
): paymentReplay.ReplaySettlement | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const status = answer as Record<string, unknown>;
  if (status.success !== true || status.status !== "success") return null;
  if (
    typeof status.transaction !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(status.transaction) ||
    status.transaction.toLowerCase() !== candidate.transaction.toLowerCase()
  ) {
    return null;
  }
  if (
    typeof status.network !== "string" ||
    status.network !== requirements.network ||
    status.network !== candidate.network
  ) {
    return null;
  }
  if (candidate.amount !== requirements.amount) return null;
  if (
    status.amount !== undefined &&
    (typeof status.amount !== "string" || status.amount !== candidate.amount)
  ) {
    return null;
  }
  if (status.payer !== undefined) {
    if (
      typeof status.payer !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(status.payer) ||
      (candidate.payer !== undefined &&
        status.payer.toLowerCase() !== candidate.payer.toLowerCase())
    ) {
      return null;
    }
  }
  return {
    transaction: candidate.transaction,
    network: candidate.network,
    amount: candidate.amount,
    ...(candidate.payer !== undefined ? { payer: candidate.payer } : {}),
  };
}

function replayResponse(
  request: paymentReplay.ReplayRequestIdentity,
  state: {
    reportId?: string;
    settlement?: paymentReplay.ReplaySettlement;
  },
): Response {
  const owner = state.reportId ? archive.byId(state.reportId) : null;
  if (!owner || !state.settlement) {
    return new Response(
      JSON.stringify({
        error: "payment_replay_unavailable",
        charged: "confirmed",
        message:
          "This payment was already settled, but its recovery owner could not be read. No new payment was attempted; contact support with the payment transaction.",
        paymentTransaction: state.settlement?.transaction,
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "60",
          ...(state.settlement
            ? { "payment-response": replayReceiptHeader(state.settlement) }
            : {}),
        },
      },
    );
  }

  const paymentResponse = replayReceiptHeader(state.settlement);
  if (replaySameDelivery(request, owner)) {
    return new Response(owner.deliverable, {
      status: 200,
      headers: {
        "content-type": owner.contentType,
        "payment-response": paymentResponse,
      },
    });
  }

  return new Response(
    JSON.stringify({
      error: "payment_already_used",
      chargedAgain: false,
      paymentTransaction: state.settlement.transaction,
      message:
        "That payment already identifies a different report. Recover the original report with its payment transaction; no second settlement was attempted.",
    }),
    {
      status: 409,
      headers: {
        "content-type": "application/json",
        "payment-response": paymentResponse,
      },
    },
  );
}

// x402 payment gate on POST /dossier. The OKX SDK builds the marketplace-validated
// 402 challenge (correct PAYMENT-REQUIRED header, USD₮0 on eip155:196) and, via the
// facilitator, verifies the buyer's signed payment and settles after a successful
// response. We supply only price, payout address, and facilitator credentials.
// Skipped entirely in local dev (no creds) so the engine stays testable.
// Fail closed: if facilitator credentials are missing in production (e.g. an
// env var wiped by a project re-link), the paid routes must go dark rather
// than silently serve for free while the marketplace listing says paid.
if (config.devSkipPayment) paymentLayer = "disabled";

const startupArchive = archive.readiness();
const startupReplayReady = paymentReplay.ready();
const archiveConfiguredForPayments =
  archiveReadyForExternalPayments(startupArchive) && startupReplayReady;

if (!config.devSkipPayment) {
  if (startupArchive.mode === "migration" && startupArchive.unsignedRecords > 0) {
    console.warn(
      `[archive] migration mode: ${startupArchive.unsignedRecords} unsigned record(s) remain; ` +
        "strict authentication is not ready",
    );
  } else if (startupArchive.mode === "unsigned") {
    console.warn(
      "[archive] authentication is disabled; configure ARCHIVE_MAC_KEY before enabling strict mode",
    );
  }
  if (!archiveConfiguredForPayments) {
    console.error(
      "[payment] paid routes disabled: " +
        (startupArchive.ready
          ? startupReplayReady
            ? "durable payment state unavailable"
            : "payment replay storage unavailable"
          : `archive unavailable (${startupArchive.reason ?? startupArchive.mode})`),
    );
  }
}

if (!config.devSkipPayment && (!paymentConfigured() || !archiveConfiguredForPayments)) {
  paymentLayer = "not_configured";
  const dark = async (c: any, next: any) => {
    // Our own fulfilment daemon is exempt, and has to be. A task-mode buyer
    // paid OKX at the task level and never signs an x402 payment at all, so a
    // missing facilitator credential says nothing about whether they are owed a
    // report — they are. Going dark on the daemon too meant a credential outage
    // stopped us serving the one class of buyer whose payment is not in doubt.
    //
    // This does not reopen the hole this block exists to close. The bypass is
    // the same shared secret that already exempts the daemon when payments are
    // working, so it grants nothing new; every external caller still gets 503
    // rather than a free report.
    if (c.get("internal")) return next();
    return c.json(
      {
        error: !paymentConfigured()
          ? "payment layer not configured — service temporarily unavailable"
          : "recovery and payment replay state not ready — service temporarily unavailable",
      },
      503,
    );
  };
  app.on(["GET", "POST", "HEAD"], "/dossier", dark);
}

if (!config.devSkipPayment && paymentConfigured() && archiveConfiguredForPayments) {
  // Wrapped so a call that comes back with no answer at all is remembered, and
  // the SDK's 402 can be corrected to a 503 further down. See
  // src/x402-facilitator.ts for why that distinction is worth the wrapper.
  const facilitator = watchFacilitator(
    new OKXFacilitatorClient({
      apiKey: config.okx.apiKey,
      secretKey: config.okx.secretKey,
      passphrase: config.okx.passphrase,
      // Wait for on-chain confirmation so a settled response is truly paid.
      syncSettle: true,
    }),
  );
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network,
    new ExactEvmScheme(),
  );
  resourceServer.onBeforeVerify(async ({ paymentPayload, requirements }) => {
    const state = currentFacilitatorState();
    if (!state) {
      return {
        abort: true,
        reason: "payment_replay_state_unavailable",
        message: "Payment replay protection is unavailable.",
      };
    }
    const params = state.replay?.request;
    const fingerprint = paymentReplay.fingerprintPayment(paymentPayload, requirements);
    if (!params || !fingerprint) {
      state.replay = { decision: { kind: "unavailable" } };
      return {
        abort: true,
        reason: "payment_replay_state_unavailable",
        message: "Payment replay protection is unavailable.",
      };
    }
    const requirementIdentity: paymentReplay.ReplayRequirements = {
      scheme: requirements.scheme,
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
    };
    const existing = paymentReplay.existing(fingerprint);
    const reconciliationId = paymentReplay.reconciliationId(fingerprint) ?? undefined;
    if (existing.kind === "found") {
      const pending = existing.state;
      const decision = pending.status === "confirmed"
        ? { kind: "confirmed" as const, state: pending }
        : { kind: "in_flight" as const, state: pending };
      if (decision.kind === "in_flight") {
      let repairSettlement =
        pending.settlementEvidence === "confirmed" ? pending.settlement : undefined;
      if (
        pending.status === "unknown" &&
        pending.settlementEvidence === "candidate" &&
        pending.settlement &&
        pending.reportId
      ) {
        try {
          const statusAnswer = await facilitator.getSettleStatus(
            pending.settlement.transaction,
          );
          const statusConfirmed = confirmedSettlementFromStatus(
            pending.settlement,
            statusAnswer,
            requirementIdentity,
          );
          repairSettlement =
            statusConfirmed &&
            paymentReplay.confirmSettlementCandidate(
              fingerprint,
              pending.attemptToken,
              statusConfirmed,
            )
              ? statusConfirmed
              : undefined;
        } catch {
          // The original attempt remains unknown. The hook below aborts this
          // exact retry before verify/settle, so a status outage cannot charge
          // the authorization again or promote its candidate transaction.
          repairSettlement = undefined;
        }
      }
      const candidateUnconfirmed =
        pending.settlementEvidence === "candidate" &&
        !repairSettlement;
      let owner =
        !candidateUnconfirmed && pending.reportId
          ? archive.settledById(pending.reportId)
          : null;
      let confirmed = replaySettlementFromArchive(owner?.settlement);
      let conflictCandidateId: string | undefined;
      if (
        repairSettlement &&
        (!confirmed || !replaySettlementMatches(confirmed, repairSettlement))
      ) {
        // Confirmed replay evidence fixes the exact transaction identity. Never
        // let a different transaction that later appeared on the staged record
        // overwrite it during recovery. Prefer the archive's authoritative
        // owner of that exact transaction, and adopt it only when every field
        // still matches.
        const authoritative = archive.byTransaction(repairSettlement.transaction);
        const authoritativeSettlement = replaySettlementFromArchive(
          authoritative?.settlement,
        );
        if (
          authoritative &&
          authoritativeSettlement &&
          replaySettlementMatches(authoritativeSettlement, repairSettlement)
        ) {
          owner = authoritative;
          confirmed = authoritativeSettlement;
          if (pending.reportId && authoritative.id !== pending.reportId) {
            conflictCandidateId = pending.reportId;
          }
        } else {
          owner = null;
          confirmed = null;
        }
      }
      // A validated settlement receipt can be committed to replay state before
      // archive ownership if the claim write hits a transient lock/filesystem
      // failure. Retrying the exact payment must repair that boundary rather
      // than remain `in_flight` forever despite holding both the staged bytes
      // and authenticated settlement identity.
      if (!owner && pending.reportId && repairSettlement) {
        const relinked = archive.linkConfirmedSettlement(pending.reportId, {
          status: "confirmed",
          transaction: repairSettlement.transaction,
          network: repairSettlement.network,
          ...(repairSettlement.amount !== undefined
            ? { amount: repairSettlement.amount }
            : {}),
          ...(repairSettlement.payer !== undefined
            ? { payer: repairSettlement.payer }
            : {}),
        });
        if (relinked.kind === "linked" || relinked.kind === "already_linked") {
          const relinkedSettlement = replaySettlementFromArchive(
            relinked.owner.settlement,
          );
          if (
            relinkedSettlement &&
            replaySettlementMatches(relinkedSettlement, repairSettlement)
          ) {
            owner = relinked.owner;
            confirmed = relinkedSettlement;
          }
        } else if (relinked.kind === "transaction_conflict") {
          const authoritative = replaySettlementFromArchive(relinked.owner.settlement);
          if (authoritative && replaySettlementMatches(authoritative, repairSettlement)) {
            owner = relinked.owner;
            confirmed = authoritative;
            conflictCandidateId = pending.reportId;
          }
        }
      }
      const replayCommitted = Boolean(
        owner &&
          confirmed &&
          (conflictCandidateId
            ? paymentReplay.adoptConflictOwner(
                fingerprint,
                pending.attemptToken,
                conflictCandidateId,
                owner.id,
                confirmed,
              )
            : paymentReplay.finalize(
                fingerprint,
                pending.attemptToken,
                owner.id,
                confirmed,
              )),
      );
      if (
        owner &&
        confirmed &&
        replayCommitted
      ) {
        if (conflictCandidateId) {
          // Conflict adoption removes the retention hold only after the
          // authoritative replay state is durable. At that point the losing
          // candidate is unclaimed and can be discarded just like the
          // immediate post-settlement conflict path does.
          archive.discard(conflictCandidateId);
        }
        state.replay = {
          fingerprint,
          reconciliationId,
          request: params,
          decision: {
            kind: "confirmed",
            state: {
              ...pending,
              status: "confirmed",
              reportId: owner.id,
              settlement: confirmed,
            },
          },
        };
        return {
          abort: true,
          reason: "dossier_replay_confirmed",
          message: "Dossier payment replay recovered from durable settlement ownership.",
        };
      }
      }
      state.replay = {
        fingerprint,
        reconciliationId,
        request: params,
        decision:
          decision.kind === "confirmed"
            ? { kind: "confirmed", state: decision.state }
            : { kind: "in_flight", state: decision.state },
      };
      return {
        abort: true,
        reason: `dossier_replay_${decision.kind}`,
        message: "Dossier payment replay decision recorded.",
      };
    }
    if (existing.kind !== "not_found") {
      state.replay = { decision: { kind: "unavailable" } };
      return {
        abort: true,
        reason: "payment_replay_state_unavailable",
        message: "Payment replay protection is unavailable.",
      };
    }
    // New authorizations are not written here. The facilitator must first
    // authenticate the signature; otherwise every unique bogus nonce can
    // create/delete a replay sidecar and invalidate the readiness cache.
    state.replay = {
      fingerprint,
      reconciliationId,
      request: params,
    };
    return;
  });
  resourceServer.onAfterVerify(async ({ requirements, result }) => {
    const state = currentFacilitatorState();
    const replay = state?.replay;
    if (!result.isValid || !replay?.fingerprint || replay.decision) return;
    const params = replay.request;
    if (!params) {
      replay.decision = { kind: "unavailable" };
      return;
    }
    const requirementIdentity: paymentReplay.ReplayRequirements = {
      scheme: requirements.scheme,
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
    };
    const begun = paymentReplay.begin(
      replay.fingerprint,
      params,
      requirementIdentity,
    );
    if (begun.kind === "created") {
      replay.attemptToken = begun.attemptToken;
      return;
    }
    replay.beginFailed = true;
    replay.decision = begun.kind === "confirmed"
      ? { kind: "confirmed", state: begun.state }
      : begun.kind === "in_flight"
        ? { kind: "in_flight", state: begun.state }
        : { kind: "unavailable" };
  });
  const dossierAccepts = {
    scheme: "exact",
    price: config.dossierPrice,
    network: config.network,
    payTo: config.payTo,
    maxTimeoutSeconds: 300,
  } as const;
  const dossierDescription =
    "Full due-diligence dossier on a token, returned as a shareable formatted report.";

  // Machine-readable parameter contract, served in the body of the unpaid 402
  // (which the SDK otherwise leaves as `{}`). A caller that has never seen this
  // service — a marketplace validator, a buying agent — can discover exactly
  // what to send and what it will get back without paying first.
  const unpaidBody =
    (
      name: string,
      description: string,
      input: unknown,
      outputMimeType: string,
      outputDescription: string,
    ) =>
    () => ({
      contentType: "application/json",
      body: {
        error: "Payment required",
        service: name,
        description,
        price: `${config.dossierPrice} per call, x402 on X Layer (${config.network})`,
        method: "GET or POST",
        parameters: "JSON body on POST, or query string on GET or POST",
        input,
        output: { mimeType: outputMimeType, description: outputDescription },
        // Worked examples, not just a schema. A reviewer or a cold agent that
        // cannot pay still needs to see what a real call looks like and what it
        // returns; a schema alone answers neither. The body has no size ceiling,
        // unlike the challenge header, so this is the right place for them.
        examples: [
          {
            description:
              "Minimal call: the contract address is the only required field.",
            request: {
              tokenAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
            },
            curl:
              `curl -X POST ${config.publicOrigin}/dossier ` +
              `-H 'content-type: application/json' ` +
              `-d '{"tokenAddress":"0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"}'`,
            returns: "The rendered report document (text/html).",
          },
          {
            description: "Name the chain explicitly and take the data as JSON.",
            request: {
              tokenAddress: "0x514910771af9ca656af840dff83e8264ecf986ca",
              chain: "ethereum",
              format: "json",
            },
            curl:
              `curl -X POST ${config.publicOrigin}/dossier ` +
              `-H 'content-type: application/json' ` +
              `-d '{"tokenAddress":"0x514910771af9ca656af840dff83e8264ecf986ca","chain":"ethereum","format":"json"}'`,
            returns:
              "JSON with riskVerdict (verdict, reasons, confidence, maxSizeUsd), token, checks, sources and a signed attestation.",
          },
        ],
        // Everything here answers without payment, so the service can be judged
        // before anyone is asked to trust it with money.
        try_before_paying: {
          sample_report: `${config.publicOrigin}/dossier/sample`,
          coverage_preflight: `${config.publicOrigin}/dossier/preflight`,
          verify_a_report: `${config.publicOrigin}/verify`,
          service_info: `${config.publicOrigin}/info`,
        },
      },
    });
  // Every method that can reach a paid path is gated, not just POST: x402
  // validators and availability probes use GET and HEAD, and an unpaid 2xx on
  // a paid path fails validation outright.
  const routes = {
      ...Object.fromEntries(
        ["POST", "GET", "HEAD"].map((m) => [
          `${m} /dossier`,
          {
            accepts: dossierAccepts,
            resource: `${config.publicOrigin}/dossier`,
            description: dossierDescription,
            mimeType: "text/html",
            extensions: httpInputSchema(
              dossierInputSchema,
              "text/html",
              "Self-contained due-diligence report document; format:json returns the same data as JSON.",
            ),
            unpaidResponseBody: unpaidBody(
              "Token Due-Diligence Report",
              dossierDescription,
              dossierInputSchema,
              "text/html",
              "Self-contained due-diligence report document; format:json returns the same data as JSON.",
            ),
          },
        ]),
      ),
    };
  const httpResourceServer = new x402HTTPResourceServer(resourceServer, routes);
  const pay = paymentMiddlewareFromHTTPServer(
    httpResourceServer,
    undefined,
    undefined,
    // The SDK's own startup sync runs outside any request, so a facilitator
    // that rejects our credentials produced an unhandled rejection and Node
    // exited — a 401 from OKX took the whole site down, free pages included,
    // in a restart loop. It is disabled here and driven below instead, where
    // the failure is ours to handle.
    false,
  );

  // Initialise on our own terms: the middleware cannot build a challenge until
  // the facilitator has told it which schemes are supported, so this must
  // happen, but it must not be able to kill the process. A bounded retry burst
  // degrades paid readiness; later bounded bursts heal in the background. This
  // avoids one unbounded async loop while keeping the free surface alive.
  const FACILITATOR_INIT_BURST = 5;
  const FACILITATOR_INIT_TIMEOUT_MS = 10_000;
  const FACILITATOR_INIT_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;
  const FACILITATOR_RETRY_BURST_AFTER_MS = 60_000;
  const initializeFacilitator = singleFlight(() => httpResourceServer.initialize());
  const initFacilitator = async (): Promise<void> => {
    const result = await runFacilitatorInitBurst({
      initialize: initializeFacilitator,
      timeoutMs: FACILITATOR_INIT_TIMEOUT_MS,
      burstSize: FACILITATOR_INIT_BURST,
      retryDelaysMs: FACILITATOR_INIT_RETRY_MS,
      onAttempt: () => {
        facilitatorInitAttempts++;
        facilitatorLastAttemptAt = new Date().toISOString();
      },
      onFailure: (attempt, error, wait) => {
        paymentLayer = "failing";
        facilitatorLastFailureAt = new Date().toISOString();
        console.error(
          `[x402] facilitator init failed (attempt ${attempt}/${FACILITATOR_INIT_BURST})${
            wait ? `, retrying in ${wait / 1000}s` : ""
          }:`,
          (error as Error)?.message?.slice(0, 160) ?? error,
        );
      },
    });
    if (result.kind === "ready") {
      paymentLayer = "ready";
      facilitatorLastSuccessAt = new Date().toISOString();
      console.log("[x402] facilitator ready");
      return;
    }
    console.error(
      `[x402] facilitator init retry burst exhausted; paid readiness remains false, retrying a bounded burst in ${
        FACILITATOR_RETRY_BURST_AFTER_MS / 1000
      }s`,
    );
    const retry = setTimeout(
      () => void initFacilitator(),
      FACILITATOR_RETRY_BURST_AFTER_MS,
    );
    retry.unref();
  };
  void initFacilitator();
  // Startup resilience: in a fresh process the SDK's first facilitator sync
  // can transiently fail and rethrow (→ 500). Retry once after a short pause
  // so an initialization blip self-heals into a normal 402 instead of a 500 an
  // OKX reviewer might hit. The retry is allowed only
  // when the failure happened before the route handler started — once next()
  // has run, replaying the chain could re-execute the handler and re-enter
  // settlement, so those errors propagate instead.
  app.use(async (c, next) => {
    // A2A fulfillment bypass: our own daemon delivers reports into the task
    // channel after the buyer already paid at the task level, so its fetches
    // must not hit the x402 gate again. Guarded by a non-empty shared secret.
    if ((c as any).get("internal")) {
      return next();
    }
    const liveDurability = durabilityHealth();
    if (
      !archiveReadyForExternalPayments(liveDurability.archive) ||
      !liveDurability.replayReady
    ) {
      return c.json(
        {
          error: "authenticated recovery and payment replay state are not ready",
        },
        503,
      );
    }
    const replayRequest = replayRequestIdentity(await readParams(c));
    let handlerStarted = false;
    const trackedNext = async () => {
      if (currentFacilitatorState()?.replay?.beginFailed) {
        c.res = new Response(
          JSON.stringify({
            error: "payment_replay_unavailable",
            message:
              "Payment was verified, but durable replay ownership could not be created. Nothing was delivered or settled; retry the same authorization shortly.",
            charged: false,
          }),
          {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "60" },
          },
        );
        return;
      }
      handlerStarted = true;
      await next();
    };
    // The SDK settles after the handler returns and puts the receipt in the
    // PAYMENT-RESPONSE header. A failed receipt can still carry a transaction
    // hash, so neither the hash nor the header alone proves settlement. Link a
    // report only from a final, successful receipt on the network we charged.
    const sameDelivery = (
      current: archive.ArchiveRecord | null,
      owner: archive.ArchiveRecord,
    ): boolean => {
      if (!current || current.contentType !== owner.contentType) return false;
      const currentHashes = [current.paramsSha256, current.resolvedParamsSha256].filter(
        (v): v is string => Boolean(v),
      );
      const ownerHashes = [owner.paramsSha256, owner.resolvedParamsSha256].filter(
        (v): v is string => Boolean(v),
      );
      return currentHashes.some((hash) => ownerHashes.includes(hash));
    };

    /**
     * A valid payment transaction is a one-delivery capability. If a client
     * retries the same signed payment after the first response was lost, return
     * the original archived bytes. If it retries it for another request, do not
     * hand out a second report under the first transaction's recovery proof.
     */
    const resolveTransactionConflict = (
      currentId: string,
      tx: string,
      response: Response,
      normalizedHeader: string,
      owner: archive.ArchiveRecord,
    ): void => {
      const current = archive.byId(currentId);
      if (owner && sameDelivery(current, owner)) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.set("payment-response", normalizedHeader);
        (c as any).set("archiveId", owner.id);
        c.res = new Response(owner.deliverable, { status: 200, headers });
        return;
      }

      // The payment has already been accepted, but this request is not the
      // report that transaction originally bought. Keep the proof header so a
      // client can recover the original delivery, while making it explicit
      // that no second report was delivered.
      const headers = new Headers({
        "content-type": "application/json",
        "payment-response": normalizedHeader,
      });
      (c as any).set("archiveId", undefined);
      c.res = new Response(
        JSON.stringify({
          error: "payment_already_used",
          chargedAgain: false,
          paymentTransaction: tx,
          message:
            "That payment transaction already identifies a different report. Recover the original report with this transaction hash.",
        }),
        { status: 409, headers },
      );
    };

    const linkSettlement = (settlementState?: Unreached) => {
      let stagedId: string | undefined;
      let normalizedHeader: string | null | undefined;
      try {
        const h = (c as any).get("archiveId") as string | undefined;
        stagedId = h;
        const response = c.res;
        if (!response || response.status < 200 || response.status >= 300) return;
        if (!h) {
          const replay = settlementState?.replay;
          if (replay?.fingerprint && replay.attemptToken) {
            // No report was staged, so there is nothing to reconcile or serve
            // on a retry. Remove the unused attempt instead of leaving a
            // permanent `report_failed` sidecar that every retry can only
            // answer as in-flight.
            paymentReplay.release(replay.fingerprint, replay.attemptToken);
          }
          return;
        }

        const originalHeader = response.headers.get("payment-response");
        const expected = settlementState?.settlementExpected;
        const header = normalizeTimeoutRecoveryReceipt(
          originalHeader,
          settlementState?.settlementAnswer,
          settlementState?.settlementPoll?.answer,
          expected?.network
            ? {
                ...(expected.scheme ? { scheme: expected.scheme } : {}),
                network: expected.network,
                ...(expected.amount ? { amount: expected.amount } : {}),
                ...(settlementState?.verifiedPayer
                  ? { payer: settlementState.verifiedPayer }
                  : {}),
              }
            : undefined,
        );
        normalizedHeader = header;
        if (!expected?.scheme || !expected.network || !expected.amount) {
          throw new Error("settlement requirements were not captured");
        }
        const parsed = validateSettlementReceipt(header, {
          scheme: expected.scheme,
          network: expected.network,
          amount: expected.amount,
          ...(settlementState?.verifiedPayer
            ? { payer: settlementState.verifiedPayer }
            : {}),
        });
        if (!parsed.ok) {
          // Never include the header itself: facilitator extensions are outside
          // our trust boundary and may contain data that does not belong in a
          // journal. The bounded reason is enough to diagnose the decision.
          console.error(`[x402] settlement receipt not linked: ${parsed.reason}`);
          // Keep the staged report: a malformed, pending, or mismatched final
          // receipt leaves the on-chain outcome unknown. Deleting the only
          // candidate artefact would make later reconciliation impossible.
          (c as any).set("archiveId", undefined);
          const replay = settlementState?.replay;
          if (replay?.fingerprint && replay.attemptToken) {
            const candidateEvidence = candidateSettlementEvidence(settlementState);
            paymentReplay.markUnknown(
              replay.fingerprint,
              replay.attemptToken,
              settlementState?.settlementAnswer?.status === "timeout"
                ? "settlement_timeout"
                : "receipt_unconfirmed",
              {
                reportId: h,
                ...(candidateEvidence
                  ? { settlement: candidateEvidence, settlementEvidence: "candidate" as const }
                  : {}),
              },
            );
          }
          c.res = undefined;
          c.res = new Response(
            JSON.stringify({
              error: "settlement_unconfirmed",
              charged: "unknown",
              message:
                "The payment facilitator did not provide a final receipt that matches this purchase, so no report was delivered. Retry with the same signed payment rather than authorizing a new one.",
              ...(replay?.reconciliationId
                ? { reconciliationId: replay.reconciliationId }
                : {}),
            }),
            {
              status: 503,
              headers: {
                "content-type": "application/json",
                "retry-after": "60",
              },
            },
          );
          return;
        }

        // Repair the SDK's timeout-recovery header for the buyer as well as for
        // our local validator. The normalized value is still derived only from
        // the bounded direct settle answer and matching final header fields.
        if (header && header !== originalHeader) {
          response.headers.set("payment-response", header);
        }

        const linked = archive.linkConfirmedSettlement(h, {
          status: "confirmed",
          transaction: parsed.receipt.transaction,
          network: parsed.receipt.network,
          ...(parsed.receipt.amount !== undefined
            ? { amount: parsed.receipt.amount }
            : {}),
          ...(parsed.receipt.payer !== undefined
            ? { payer: parsed.receipt.payer }
            : {}),
        });
        const confirmed = {
          status: "confirmed" as const,
          transaction: parsed.receipt.transaction,
          network: parsed.receipt.network,
          ...(parsed.receipt.amount !== undefined
            ? { amount: parsed.receipt.amount }
            : {}),
          ...(parsed.receipt.payer !== undefined
            ? { payer: parsed.receipt.payer }
            : {}),
        };
        const replay = settlementState?.replay;
        const finalizeReplay = (
          ownerId: string,
          settlement: paymentReplay.ReplaySettlement = confirmed,
        ): boolean =>
          !replay?.fingerprint ||
          !replay.attemptToken ||
          paymentReplay.finalize(
            replay.fingerprint,
            replay.attemptToken,
            ownerId,
            settlement,
          );

        switch (linked.kind) {
          case "linked":
          case "already_linked": {
            (c as any).set("confirmedSettlement", confirmed);
            if (!finalizeReplay(linked.owner.id)) {
              if (replay?.fingerprint && replay.attemptToken) {
                paymentReplay.markUnknown(
                  replay.fingerprint,
                  replay.attemptToken,
                  "replay_commit_failed",
                  {
                    reportId: linked.owner.id,
                    settlement: confirmed,
                    settlementEvidence: "confirmed",
                  },
                );
              }
              (c as any).set("archiveId", undefined);
              c.res = undefined;
              c.res = new Response(
                JSON.stringify({
                  error: "payment_replay_unavailable",
                  charged: "confirmed",
                  paymentTransaction: confirmed.transaction,
                  message:
                    "Settlement and recovery ownership were confirmed, but retry state could not be committed. No report was delivered; contact support before retrying.",
                  ...(replay?.reconciliationId
                    ? { reconciliationId: replay.reconciliationId }
                    : {}),
                }),
                {
                  status: 503,
                  headers: {
                    "content-type": "application/json",
                    "retry-after": "60",
                    "payment-response": header!,
                  },
                },
              );
            }
            break;
          }
          case "transaction_conflict": {
            const ownerSettlement = replaySettlementFromArchive(linked.owner.settlement);
            const ownerMatchesConfirmed = Boolean(
              ownerSettlement &&
                replaySettlementMatches(ownerSettlement, confirmed),
            );
            const conflictReplayCommitted =
              !replay?.fingerprint ||
              !replay.attemptToken ||
              (ownerMatchesConfirmed &&
                ownerSettlement &&
                paymentReplay.adoptConflictOwner(
                  replay.fingerprint,
                  replay.attemptToken,
                  h,
                  linked.owner.id,
                  ownerSettlement,
                ));
            if (
              !ownerMatchesConfirmed ||
              !conflictReplayCommitted
            ) {
              if (replay?.fingerprint && replay.attemptToken) {
                // Settlement is final, but the replay owner transition was not
                // durable. Move the attempt out of pending so an exact retry
                // can reconcile the confirmed transaction instead of leaving
                // a permanently in-flight payment.
                paymentReplay.markUnknown(
                  replay.fingerprint,
                  replay.attemptToken,
                  "replay_commit_failed",
                  {
                    reportId: h,
                    settlement: confirmed,
                    settlementEvidence: "confirmed",
                  },
                );
              }
              (c as any).set("archiveId", undefined);
              c.res = undefined;
              c.res = new Response(
                JSON.stringify({
                  error: "payment_replay_unavailable",
                  charged: "confirmed",
                  paymentTransaction: confirmed.transaction,
                  message:
                    "The existing payment owner was found, but durable retry state could not be committed. No report was delivered; contact support before retrying.",
                  ...(replay?.reconciliationId
                    ? { reconciliationId: replay.reconciliationId }
                    : {}),
                }),
                {
                  status: 503,
                  headers: {
                    "content-type": "application/json",
                    "retry-after": "60",
                    "payment-response": header!,
                  },
                },
              );
            } else {
              (c as any).set("confirmedSettlement", linked.owner.settlement);
              resolveTransactionConflict(
                h,
                parsed.receipt.transaction,
                response,
                header!,
                linked.owner,
              );
              // Only discard after authoritative owner metadata and replay
              // finalization are durable. Before that, this candidate is the
              // last local artefact tied to the attempt and must survive.
              archive.discard(h);
            }
            break;
          }
          case "record_missing":
          case "record_unauthenticated":
          case "record_conflict":
          case "claim_invalid":
          case "write_failed": {
            // Settlement is confirmed; retaining the staged report is the only
            // way support can reconcile a claim/index write failure.
            (c as any).set("archiveId", undefined);
            if (replay?.fingerprint && replay.attemptToken) {
              paymentReplay.markUnknown(
                replay.fingerprint,
                replay.attemptToken,
                "archive_link_failed",
                {
                  reportId: h,
                  settlement: confirmed,
                  settlementEvidence: "confirmed",
                },
              );
            }
            c.res = undefined;
            c.res = new Response(
              JSON.stringify({
                error: "archive_unavailable",
                charged: "confirmed",
                message:
                  "Settlement was confirmed, but the recovery record could not be committed. No report was delivered; contact support with the payment transaction before retrying.",
                paymentTransaction: parsed.receipt.transaction,
                ...(replay?.reconciliationId
                  ? { reconciliationId: replay.reconciliationId }
                  : {}),
              }),
              {
                status: 503,
                headers: {
                  "content-type": "application/json",
                  "retry-after": "60",
                  "payment-response": header!,
                },
              },
            );
            console.error(`[x402] confirmed settlement could not be linked: ${linked.kind}`);
            break;
          }
          default: {
            const exhaustive: never = linked;
            throw new Error(`unhandled transaction link result: ${String(exhaustive)}`);
          }
        }
      } catch (e) {
        console.error(
          "[x402] settlement linking failed:",
          (e as Error)?.message?.slice(0, 160) ?? e,
        );
        // An unexpected application exception is not permission to deliver a
        // paid report without a durable recovery record. Keep the staged file
        // for operator reconciliation (the on-chain outcome may be unknown),
        // but fail the response closed.
        if (stagedId && c.res && c.res.status >= 200 && c.res.status < 300) {
          (c as any).set("archiveId", undefined);
          const replay = settlementState?.replay;
          if (replay?.fingerprint && replay.attemptToken) {
            paymentReplay.markUnknown(
              replay.fingerprint,
              replay.attemptToken,
              "archive_link_failed",
              { reportId: stagedId },
            );
          }
          const headers = new Headers({
            "content-type": "application/json",
            "retry-after": "60",
          });
          if (normalizedHeader) headers.set("payment-response", normalizedHeader);
          c.res = undefined;
          c.res = new Response(
            JSON.stringify({
              error: "archive_unavailable",
              charged: "unknown",
              message:
                "Settlement processing could not be durably committed. No report was delivered; contact support and retry only with the same signed payment.",
              ...(replay?.reconciliationId
                ? { reconciliationId: replay.reconciliationId }
                : {}),
            }),
            { status: 503, headers },
          );
        }
      }
    };
    return trackFacilitator(async (unreached) => {
    unreached.replay = { request: replayRequest };
    // The SDK answers 402 both when the facilitator refused the payment and
    // when the facilitator never answered at all. The second is not a refusal,
    // and saying it is tells a buyer who has just signed a payment that their
    // payment was rejected. Corrected here, once, at the only place that sees
    // both the record and the response.
    const honest = (res: void | Response): void | Response => {
      const current = res ?? c.res;
      if (!current || current.status !== 402) return res;
      const replayDecision = unreached.replay?.decision;
      if (replayDecision?.kind === "confirmed") {
        const request = unreached.replay?.request;
        const state = replayDecision.state as {
          reportId?: string;
          settlement?: paymentReplay.ReplaySettlement;
        };
        if (state.settlement) {
          (c as any).set("confirmedSettlement", {
            status: "confirmed",
            ...state.settlement,
          });
        }
        c.res = undefined;
        c.res = request
          ? replayResponse(request, state)
          : replayPendingResponse(unreached);
        return c.res;
      }
      if (replayDecision) {
        c.res = undefined;
        c.res = replayPendingResponse(unreached);
        return c.res;
      }
      if (unreached.settlementAnswer?.status === "timeout") {
        c.res = undefined;
        c.res = replayPendingResponse(unreached);
        return c.res;
      }
      if (!unreached.verify && !unreached.settle) return res;
      // Assigned rather than returned. Hono's `compose` only adopts a returned
      // Response while the context is unfinalized, and by here `next()` has run
      // and finalized it, so returning this would silently do nothing. Clearing
      // `c.res` first stops the setter copying the old response's headers onto
      // this one, which is the whole point: the 402 being replaced carries
      // either a payment challenge or a settlement-failed receipt.
      c.res = undefined;
      c.res = unreachable(unreached);
      return c.res;
    };
    const pendingResponseStatus = (): number => (c.res?.status ?? 0);
    const retainUnknownReplay = (
      reason: paymentReplay.ReplayUnknownReason,
      reportId?: string,
    ): void => {
      const replay = unreached.replay;
      if (!replay?.fingerprint || !replay.attemptToken) return;
      const settlement = candidateSettlementEvidence(unreached);
      paymentReplay.markUnknown(replay.fingerprint, replay.attemptToken, reason, {
        ...(reportId ? { reportId } : {}),
        ...(settlement
          ? { settlement, settlementEvidence: "candidate" as const }
          : {}),
      });
    };
    const releaseUnsettledReplay = (): void => {
      const replay = unreached.replay;
      if (!replay?.fingerprint || !replay.attemptToken) return;
      paymentReplay.release(replay.fingerprint, replay.attemptToken);
    };
    try {
      // pay() returns a Response for the unpaid 402 path and undefined once a
      // verified payment has run the handler — both must be passed through
      // unchanged, or Hono reports the context as unfinalized.
      const res = await pay(c, trackedNext);
      linkSettlement(unreached);
      const staged = (c as any).get("archiveId") as string | undefined;
      const current = res ?? c.res;
      if (
        staged &&
        current?.status === 402 &&
        !unreached.settle &&
        settlementStateIsDefiniteFailure(unreached)
      ) {
        releaseUnsettledReplay();
        archive.discard(staged);
        (c as any).set("archiveId", undefined);
      }
      if (!staged && pendingResponseStatus() >= 400 && !unreached.settle) {
        releaseUnsettledReplay();
      }
      if (
        unreached.settlementAnswer?.status === "timeout" &&
        pendingResponseStatus() >= 400
      ) {
        retainUnknownReplay("settlement_timeout", staged);
      } else if (unreached.settle) {
        retainUnknownReplay("settlement_unreachable", staged);
      }
      return honest(res);
    } catch (e) {
      if (handlerStarted) {
        // The handler may already have durably attached a staged report. If no
        // settle call was attempted, this exception is definitely uncharged
        // and the attempt can be released for a clean retry. If settlement was
        // entered (or its state is unclear), retain the bytes and mark the
        // fingerprint unknown so the same authorization can be reconciled
        // without ever settling a second time.
        const replay = unreached.replay;
        const staged = (c as any).get("archiveId") as string | undefined;
        if (replay?.fingerprint && replay.attemptToken) {
          if (unreached.settle || unreached.settlementAnswer) {
            const settlement = candidateSettlementEvidence(unreached);
            paymentReplay.markUnknown(
              replay.fingerprint,
              replay.attemptToken,
              unreached.settlementAnswer?.status === "timeout"
                ? "settlement_timeout"
                : "settlement_unreachable",
              {
                ...(staged ? { reportId: staged } : {}),
                ...(settlement
                  ? { settlement, settlementEvidence: "candidate" as const }
                  : {}),
              },
            );
          } else {
            if (staged) archive.discard(staged);
            paymentReplay.release(replay.fingerprint, replay.attemptToken);
            (c as any).set("archiveId", undefined);
          }
        }
        throw e;
      }
      // Nothing reached the handler, so settlement cannot have started. If the
      // failed pass had already claimed this payment fingerprint, release that
      // request-owned claim before retrying; otherwise the retry sees its own
      // state as an unrelated in-flight payment and cannot self-heal.
      releaseUnsettledReplay();
      unreached.replay = { request: replayRequest };
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await pay(c, next);
        linkSettlement(unreached);
        const staged = (c as any).get("archiveId") as string | undefined;
        const current = res ?? c.res;
        if (
          staged &&
          current?.status === 402 &&
          !unreached.settle &&
          settlementStateIsDefiniteFailure(unreached)
        ) {
          releaseUnsettledReplay();
          archive.discard(staged);
          (c as any).set("archiveId", undefined);
        }
        if (!staged && pendingResponseStatus() >= 400 && !unreached.settle) {
          releaseUnsettledReplay();
        }
        if (
          unreached.settlementAnswer?.status === "timeout" &&
          pendingResponseStatus() >= 400
        ) {
          retainUnknownReplay("settlement_timeout", staged);
        } else if (unreached.settle) {
          retainUnknownReplay("settlement_unreachable", staged);
        }
        return honest(res);
      } catch (again) {
        const replay = unreached.replay;
        const staged = (c as any).get("archiveId") as string | undefined;
        if (replay?.fingerprint && replay.attemptToken) {
          if (unreached.settle || unreached.settlementAnswer) {
            const settlement = candidateSettlementEvidence(unreached);
            paymentReplay.markUnknown(
              replay.fingerprint,
              replay.attemptToken,
              unreached.settlementAnswer?.status === "timeout"
                ? "settlement_timeout"
                : "settlement_unreachable",
              {
                ...(staged ? { reportId: staged } : {}),
                ...(settlement
                  ? { settlement, settlementEvidence: "candidate" as const }
                  : {}),
              },
            );
          } else {
            if (staged) archive.discard(staged);
            paymentReplay.release(replay.fingerprint, replay.attemptToken);
            (c as any).set("archiveId", undefined);
          }
        }
        // The payment layer is unreachable or is refusing our credentials.
        // Go dark on the paid routes rather than 500, and above all stay
        // alive: the free surface has nothing to do with the facilitator.
        console.error(
          "[x402] payment layer unavailable:",
          (again as Error)?.message?.slice(0, 200) ?? again,
        );
        if (unreached.settle || unreached.settlementAnswer) {
          c.res = undefined;
          c.res = replayPendingResponse(unreached);
          return c.res;
        }
        c.header("Retry-After", "60");
        return c.json(
          {
            error:
              "payment layer temporarily unavailable — no payment was taken, retry shortly",
          },
          503,
        );
      }
    }
    });
  });
}

// Buyers' x402 clients do not all replay the same way: some POST the original
// JSON body, some replay with GET and carry the parameters in the query string
// (OKX's own `payment quote` defaults to GET). Accepting only a POST body meant
// a paid caller could be answered 400 and get no report, so parameters are read
// from the query string and the JSON body alike, with the body winning.
async function readParams(c: any): Promise<Record<string, unknown>> {
  const query = c.req.query() as Record<string, string>;
  let body: unknown = {};
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD") body = await c.req.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  return { ...query, ...(body as Record<string, unknown>) };
}

/** e.g. dossier-uni-ethereum-20260727.html — safe on every filesystem. */
function downloadName(
  d: { token: { symbol?: string; chain: string; address: string } },
  json: boolean,
): string {
  const label = (d.token.symbol || d.token.address.slice(0, 10)).replace(
    /[^A-Za-z0-9._-]/g,
    "",
  );
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `dossier-${label.toLowerCase()}-${d.token.chain}-${day}.${json ? "json" : "html"}`;
}

const invalid = (c: any, issues: unknown) =>
  c.json(
    {
      error: "invalid request",
      hint: "send tokenAddress either as a JSON body on POST or as a query parameter on GET or POST.",
      examples: {
        post: 'POST /dossier  {"tokenAddress":"0x…","chain":"(optional)"}',
        get: "GET /dossier?tokenAddress=0x…&chain=(optional)",
      },
      freeSample: "/dossier/sample",
      issues,
    },
    400,
  );

app.on(["GET", "POST"], "/dossier", async (c) => {
  // Reached only after the middleware has verified payment (or in dev-skip mode).

  // HEAD never builds a report. Hono dispatches HEAD to the GET handler and HTTP
  // then strips the body, so a paid HEAD used to run every source, build the
  // report, archive it, and return 200 with zero bytes. 200 is what the SDK
  // settles on, so the caller was charged for nothing: the exact thing this
  // service promises never to do.
  //
  // 405 is deliberate rather than 402. It is >= 400, so nothing settles, and it
  // tells an honest client the truth: this method is gated so that unpaid probes
  // and marketplace validators still get their 402, but it cannot deliver a
  // document, so it must not take money for one.
  if (c.req.method === "HEAD") {
    c.header("Allow", "GET, POST");
    return c.json(
      {
        error: "method_not_allowed",
        message:
          "HEAD cannot return a report, so it is never charged. Use GET or POST. " +
          "An unpaid HEAD still answers 402 so availability probes keep working.",
        charged: false,
      },
      405,
    );
  }

  const parsed = DossierRequest.safeParse(await readParams(c));
  if (!parsed.success) {
    return invalid(c, parsed.error.issues);
  }
  const loggedJob = internalJobId(c);
  if (parsed.data.format === "message" && !loggedJob) {
    return c.json(
      {
        error: "format_not_available",
        message:
          "format=message is an internal fulfilment view of a report already delivered for a marketplace job. External paid calls must request html or json.",
        charged: false,
      },
      400,
    );
  }
  // Recorded before the work starts, so a request that goes on to fail still
  // says which token it was for. A failed paid call is exactly the one we later
  // have to explain, and "they asked for X and got a 404" is the whole answer.
  (c as any).set("logToken", parsed.data.tokenAddress);
  if (parsed.data.chain) (c as any).set("logChain", parsed.data.chain);
  if (loggedJob) (c as any).set("logJob", loggedJob);
  try {
    const dossier = await buildDossier(parsed.data);
    const json = parsed.data.format === "json";
    const message = parsed.data.format === "message";
    // Archive before responding. External paid calls also durably attach this
    // report to their payment fingerprint before the handler returns: the SDK
    // starts settlement as soon as it sees our 2xx response.
    const id = archive.newId();
    const jobId = loggedJob;
    // A recovery code is minted only for task-mode deliveries, which are the
    // ones keyed on a publicly enumerable job id. x402 deliveries are keyed on
    // the settlement transaction and deliberately need no code: see the comment
    // on the recovery route.
    //
    // Minted before the body is built, because the delivery message quotes it:
    // a buyer who is told to recover with a code has to be told the code in the
    // same breath.
    //
    // For format=message there is nothing new to archive: the message is a view
    // of a report that was already delivered and stored under this job. Giving
    // it its own record made it the newest one, so recovery handed the buyer
    // back the message instead of their document. The code is attached to the
    // report itself, which is what they will actually want.
    const messageCode =
      message && jobId ? archive.attachRecoveryCode(jobId) : null;
    const recovery = jobId && !message ? archive.newRecoveryCode() : undefined;
    const body = json
      ? JSON.stringify(dossier)
      : message
        ? renderDeliveryMessage(dossier, {
            jobId,
            recoveryCode: messageCode ?? undefined,
            endpoint: `${config.publicOrigin}/dossier`,
            fromTicker: false,
          })
        : renderDossierHtml(dossier);
    // The message is not a deliverable; archiving it would displace the report.
    if (
      !message &&
      !archive.save({
        id,
        paramsSha256: archive.paramsHash(
          parsed.data as Record<string, unknown>,
        ),
        // Also index by the chain actually analysed, since that is the one the
        // report prints and the one our own recovery instructions quote.
        resolvedParamsSha256: archive.paramsHash({
          ...(parsed.data as Record<string, unknown>),
          chain: dossier.token.chain,
        }),
        request: parsed.data as Record<string, unknown>,
        contentType: json ? "application/json" : "text/html",
        deliverable: body,
        deliveredAt: new Date().toISOString(),
        ...(jobId ? { jobId } : {}),
        ...(recovery ? { recoveryCodeSha256: recovery.hash } : {}),
      })
    ) {
      return c.json(
        {
          error: "archive_unavailable",
          message:
            "The report was built but could not be stored for recovery, so it was not delivered or charged. Retry shortly.",
          charged: false,
        },
        503,
      );
    }
    if (!message && !(c as any).get("internal") && !config.devSkipPayment) {
      const replay = currentFacilitatorState()?.replay;
      const attached = Boolean(
        replay?.fingerprint &&
          replay.attemptToken &&
          paymentReplay.attachReport(replay.fingerprint, replay.attemptToken, id),
      );
      if (!attached) {
        // This response stays non-2xx, so the SDK will not call settle. Remove
        // both halves of the unused attempt where possible; either cleanup may
        // fail under the same storage outage, but neither failure permits a
        // payment or delivery.
        const discarded = archive.discard(id);
        const released = Boolean(
          replay?.fingerprint &&
            replay.attemptToken &&
            paymentReplay.release(replay.fingerprint, replay.attemptToken),
        );
        (c as any).set("archiveId", undefined);
        console.error(
          `[x402] replay report attachment failed (archiveDiscarded=${discarded}, replayReleased=${released})`,
        );
        return c.json(
          {
            error: "payment_replay_unavailable",
            message:
              "The report was built but durable payment recovery state could not be stored, so it was not delivered or charged. Retry shortly.",
            charged: false,
            ...(replay?.reconciliationId
              ? { reconciliationId: replay.reconciliationId }
              : {}),
          },
          503,
        );
      }
      replay!.reportId = id;
    }
    if (!message) (c as any).set("archiveId", id);
    // The code leaves in a header rather than in the report body, which is
    // signed and archived: putting it there would write the capability into the
    // very artefact it protects. This header is only ever produced for an
    // authenticated internal call, so it reaches the fulfilment daemon and
    // nobody else, and the daemon prints it in the buyer's delivery message.
    const issued = messageCode ?? recovery?.code;
    if (issued) c.header("X-Recovery-Code", issued);
    // Name the artefact. Without this the marketplace saved an HTML report as a
    // .txt file, and a buyer's first sight of the deliverable was a text blob.
    // `inline` so browsers still render it; the filename is only used on save.
    c.header(
      "Content-Disposition",
      `inline; filename="${downloadName(dossier, json)}"`,
    );
    if (json) return c.json(dossier);
    if (message) return c.text(body);
    return c.html(body);
  } catch (e) {
    // Non-2xx responses are never settled, so none of these charge the buyer.
    if (e instanceof ChainNotFoundError) {
      return c.json({ error: e.message }, 404);
    }
    // Non-2xx, so the middleware never settles. Both of these cost the buyer
    // nothing; the first is the more useful message when it applies.
    if (e instanceof NotAContractError) {
      return c.json(
        {
          error: "not_a_contract",
          message: e.message,
          charged: false,
          hint: "That address has no contract code on this chain. Check the address and the chain.",
        },
        404,
      );
    }
    if (e instanceof TokenNotFoundError) {
      return c.json(
        {
          error: "token_not_found",
          message: e.message,
          charged: false,
          hint: "Check coverage before paying with the free GET /dossier/preflight?tokenAddress=0x…",
        },
        404,
      );
    }
    if (e instanceof SourcesUnavailableError) {
      c.header("Retry-After", "30");
      return c.json(
        { error: "data sources temporarily unavailable — retry shortly" },
        503,
      );
    }
    throw e;
  }
});
