import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-hono";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { config, paymentConfigured } from "./config";
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
  type Unreached,
} from "./x402-facilitator";

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
        const paid = Boolean(c.req.header("payment-signature"));
        const line: reqlog.ReqLine = {
          m: c.req.method,
          p: c.req.path,
          s: c.res?.status ?? 0,
          ms: Date.now() - started,
          ...(paid ? { paid: true } : {}),
          // Present only when the SDK actually settled. Its absence next to
          // `paid:true` is the proof that a failed call charged nobody.
          ...reqlog.decodeReceipt(c.res?.headers?.get("payment-response")),
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

// Rate limiting for the free surface only. Registered before the routes but
// after nothing else, so it cannot affect the paid paths: those are excluded by
// name below. Runs in observe mode until real traffic confirms the budgets.
const FREE_LIMITED = new Set([
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
let sampleCache: { html: string; at: number } | undefined;

app.get("/dossier/sample", async (c) => {
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
        at: Date.now(),
      };
    } catch (e) {
      if (sampleCache) return c.html(sampleCache.html); // serve stale over failing
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
  return c.html(sampleCache.html);
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

app.get("/health", (c) =>
  c.json({
    ok: true,
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
    signing: publicKey() ? "enabled" : "unsigned",
    // Published so a monitor can assert it. The limiter ran in whichever mode an
    // env var happened to select, and nothing anywhere said which, so a deploy
    // that lost the variable throttled nobody and looked identical from outside.
    rateLimit: ratelimit.mode(),
  }),
);

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

// x402 payment gate on POST /dossier. The OKX SDK builds the marketplace-validated
// 402 challenge (correct PAYMENT-REQUIRED header, USD₮0 on eip155:196) and, via the
// facilitator, verifies the buyer's signed payment and settles after a successful
// response. We supply only price, payout address, and facilitator credentials.
// Skipped entirely in local dev (no creds) so the engine stays testable.
// Fail closed: if facilitator credentials are missing in production (e.g. an
// env var wiped by a project re-link), the paid routes must go dark rather
// than silently serve for free while the marketplace listing says paid.
if (config.devSkipPayment) paymentLayer = "disabled";

if (!config.devSkipPayment && !paymentConfigured()) {
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
        error: "payment layer not configured — service temporarily unavailable",
      },
      503,
    );
  };
  app.post("/dossier", dark);
  app.get("/dossier", dark);
}

if (!config.devSkipPayment && paymentConfigured()) {
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
  const pay = paymentMiddleware(
    {
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
    },
    resourceServer,
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
  // happen, but it must not be able to kill the process. Retries with backoff
  // and keeps retrying in the background, so a facilitator outage degrades the
  // paid routes to 503 and then heals itself without a restart.
  const initFacilitator = async (): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await resourceServer.initialize();
        paymentLayer = "ready";
        console.log("[x402] facilitator ready");
        return;
      } catch (e) {
        paymentLayer = "failing";
        const wait = Math.min(60_000, 2 ** Math.min(attempt, 5) * 1000);
        console.error(
          `[x402] facilitator init failed (attempt ${attempt}), retrying in ${wait / 1000}s:`,
          (e as Error)?.message?.slice(0, 160) ?? e,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  void initFacilitator();
  // Cold-start resilience: on a fresh serverless instance the SDK's first
  // facilitator sync can transiently fail and rethrow (→ 500). Retry once
  // after a short pause so a cold-start blip self-heals into a normal 402
  // instead of a 500 an OKX reviewer might hit. The retry is allowed only
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
    let handlerStarted = false;
    const trackedNext = async () => {
      handlerStarted = true;
      await next();
    };
    // The SDK settles after the handler returns and puts the receipt in the
    // PAYMENT-RESPONSE header. Attaching that transaction to the archived
    // report is what later lets the payer — and only the payer — recover it.
    const linkSettlement = () => {
      try {
        const h = (c as any).get("archiveId");
        const pr = c.res && c.res.headers.get("payment-response");
        if (!h || !pr) return;
        const receipt = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
        if (receipt && receipt.transaction)
          archive.linkTransaction(h, String(receipt.transaction));
      } catch {
        /* recovery is best effort and must never disturb the response */
      }
    };
    return trackFacilitator(async (unreached) => {
    // The SDK answers 402 both when the facilitator refused the payment and
    // when the facilitator never answered at all. The second is not a refusal,
    // and saying it is tells a buyer who has just signed a payment that their
    // payment was rejected. Corrected here, once, at the only place that sees
    // both the record and the response.
    const honest = (res: void | Response): void | Response => {
      const current = res ?? c.res;
      if (!current || current.status !== 402) return res;
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
    try {
      // pay() returns a Response for the unpaid 402 path and undefined once a
      // verified payment has run the handler — both must be passed through
      // unchanged, or Hono reports the context as unfinalized.
      const res = await pay(c, trackedNext);
      linkSettlement();
      return honest(res);
    } catch (e) {
      if (handlerStarted) throw e;
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await pay(c, next);
        linkSettlement();
        return honest(res);
      } catch (again) {
        // The payment layer is unreachable or is refusing our credentials.
        // Go dark on the paid routes rather than 500, and above all stay
        // alive: the free surface has nothing to do with the facilitator.
        // 503 is non-2xx, so nothing can settle on this path either.
        console.error(
          "[x402] payment layer unavailable:",
          (again as Error)?.message?.slice(0, 200) ?? again,
        );
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
  // Recorded before the work starts, so a request that goes on to fail still
  // says which token it was for. A failed paid call is exactly the one we later
  // have to explain, and "they asked for X and got a 404" is the whole answer.
  (c as any).set("logToken", parsed.data.tokenAddress);
  if (parsed.data.chain) (c as any).set("logChain", parsed.data.chain);
  const loggedJob = internalJobId(c);
  if (loggedJob) (c as any).set("logJob", loggedJob);
  try {
    const dossier = await buildDossier(parsed.data);
    const json = parsed.data.format === "json";
    const message = parsed.data.format === "message";
    // Archive before responding, and remember the key so the settlement
    // transaction can be attached once the SDK has settled.
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
    if (!message)
      archive.save({
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
      });
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
