import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-hono";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { config, paymentConfigured } from "./config";
import { VerdictRequest, SUPPORTED_CHAINS } from "./verdict/schema";
import { evaluate, SourcesUnavailableError } from "./verdict/engine";
import {
  DossierRequest,
  buildDossier,
  preflight,
  ChainNotFoundError,
  TokenNotFoundError,
  NotAContractError,
} from "./dossier/report";
import { renderDossierHtml } from "./dossier/render";
import * as archive from "./dossier/archive";
import { renderSiteHtml } from "./site";
import { fontByPath } from "./fonts";
import * as ratelimit from "./ratelimit";
import {
  dossierInputSchema,
  verdictInputSchema,
  httpInputSchema,
} from "./x402-contract";

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

// Rate limiting for the free surface only. Registered before the routes but
// after nothing else, so it cannot affect the paid paths: those are excluded by
// name below. Runs in observe mode until real traffic confirms the budgets.
const FREE_LIMITED = new Set([
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
  return c.json({ error: "rate_limited", message: `Too many requests for ${path}. Retry shortly.` }, 429);
});

// Our own fulfilment daemon identifies itself with a shared secret. Resolved
// once, here, so the payment bypass and the job-id capture below cannot drift
// apart in what they consider an internal call.
app.use(async (c, next) => {
  if (config.internalKey && internalKeyMatches(c.req.header("x-internal-key"))) {
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

app.get("/info", (c) =>
  c.json({
    service: "Dossier",
    agentId: 7012,
    description:
      "One paid call returns a polished, executive-ready due-diligence report on any token: risk verdict, safe position size, security flags, liquidity, and holder distribution, compiled deterministically from live data and rendered as a self-contained document.",
    endpoints: [
      {
        path: "/dossier",
        method: "POST",
        pricing: `${config.dossierPrice} per call (x402, USD₮0 on X Layer)`,
        body: { tokenAddress: "0x…", chain: "(optional — auto-detected when unambiguous)", format: "html | json" },
      },
      {
        path: "/dossier/sample",
        method: "GET",
        pricing: "free",
        description: "A real sample report, so you can see the deliverable before paying.",
      },
      {
        path: "/dossier/preflight",
        method: "GET or POST",
        pricing: "free",
        body: { tokenAddress: "0x…", chain: "(optional)" },
        description:
          "Coverage check for a specific token before paying: which data sources have it, expected coverage, which fields the report will contain, and whether it can be produced at all.",
      },
      {
        path: "/verdict",
        method: "POST",
        pricing: `${config.price} per call (x402, USD₮0 on X Layer)`,
        description:
          "Companion service (agent #7008): the pre-trade risk decision alone — proceed/caution/abort, safe position size, confidence — as JSON.",
      },
    ],
  }),
);

// NOTE: /dossier and /verdict must NEVER answer an unpaid request with 2xx on
// ANY method. x402 validators (including OKX's `agent x402-check`, which probes
// with GET) treat a 200 as "not a valid x402 service" and reject the listing.
// Usage information lives on `/` and the free `/dossier/sample` instead; the
// paid paths are gated for GET and POST alike below.

// Free sample report on a well-known token, cached in-instance so repeat views
// don't burn free-API quota. Lets buyers and reviewers see the asset up front.
const SAMPLE = { chain: "bsc", tokenAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" } as const; // CAKE
const SAMPLE_TTL_MS = 6 * 60 * 60 * 1000;
let sampleCache: { html: string; at: number } | undefined;

app.get("/dossier/sample", async (c) => {
  if (!sampleCache || Date.now() - sampleCache.at > SAMPLE_TTL_MS) {
    try {
      const dossier = await buildDossier({ ...SAMPLE, format: "html" });
      sampleCache = {
        html: renderDossierHtml(dossier, {
          banner:
            "Sample report (free). Every paid call to POST /dossier returns this document for the token you choose. 0.5 USD₮0 per call over x402 on X Layer · OKX.AI agent #7012.",
        }),
        at: Date.now(),
      };
    } catch (e) {
      if (sampleCache) return c.html(sampleCache.html); // serve stale over failing
      if (e instanceof SourcesUnavailableError) {
        c.header("Retry-After", "30");
        return c.json({ error: "data sources temporarily unavailable — retry shortly" }, 503);
      }
      throw e;
    }
  }
  return c.html(sampleCache.html);
});

// Coverage preflight, free: what the paid report will and will not contain for
// this token, so nobody pays 0.50 to discover that a token has no market data.
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
      return c.json({ error: "chain_not_found", message: e.message, reportAvailable: false }, 404);
    }
    if (e instanceof SourcesUnavailableError) {
      c.header("Retry-After", "30");
      return c.json({ error: "data sources temporarily unavailable — retry shortly" }, 503);
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
  const givenHash = String(p.requestParamsSha256 || p.requestBodySha256 || "").trim();
  let originalBody = p.originalBody as Record<string, unknown> | undefined;
  if (typeof originalBody === "string") {
    try { originalBody = JSON.parse(originalBody); } catch { originalBody = undefined; }
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
          "If you bought through a marketplace task instead, send jobId. " +
          "originalBody or requestParamsSha256 may be sent as an additional check.",
        usage: {
          post: 'POST /dossier/recovery {"paymentTransaction":"0x…"}  or  {"jobId":"0x…"}',
          get: "GET /dossier/recovery?paymentTransaction=0x…  or  ?jobId=0x…",
        },
      },
      400,
    );
  }

  const hash = givenHash || (originalBody ? archive.paramsHash(originalBody) : "");
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
  // If the caller also supplied the request, it must be the one that was paid for.
  if (hash && rec.paramsSha256 !== hash) {
    return c.json(
      { error: "proof_mismatch", message: "That transaction did not pay for those request parameters." },
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

app.get("/health", (c) =>
  c.json({
    ok: true,
    devSkipPayment: config.devSkipPayment,
    paymentConfigured: paymentConfigured(),
  }),
);

// x402 payment gate on POST /verdict. The OKX SDK builds the marketplace-validated
// 402 challenge (correct PAYMENT-REQUIRED header, USD₮0 on eip155:196) and, via the
// facilitator, verifies the buyer's signed payment and settles after a successful
// response. We supply only price, payout address, and facilitator credentials.
// Skipped entirely in local dev (no creds) so the engine stays testable.
// Fail closed: if facilitator credentials are missing in production (e.g. an
// env var wiped by a project re-link), the paid routes must go dark rather
// than silently serve for free while the marketplace listing says paid.
if (!config.devSkipPayment && !paymentConfigured()) {
  const dark = (c: any) =>
    c.json({ error: "payment layer not configured — service temporarily unavailable" }, 503);
  app.post("/verdict", dark);
  app.post("/dossier", dark);
  app.get("/verdict", dark);
  app.get("/dossier", dark);
}

if (!config.devSkipPayment && paymentConfigured()) {
  const facilitator = new OKXFacilitatorClient({
    apiKey: config.okx.apiKey,
    secretKey: config.okx.secretKey,
    passphrase: config.okx.passphrase,
    // Wait for on-chain confirmation so a settled response is truly paid.
    syncSettle: true,
  });
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network,
    new ExactEvmScheme(),
  );
  const verdictAccepts = {
    scheme: "exact",
    price: config.price,
    network: config.network,
    payTo: config.payTo,
    maxTimeoutSeconds: 300,
  } as const;
  const dossierAccepts = {
    scheme: "exact",
    price: config.dossierPrice,
    network: config.network,
    payTo: config.payTo,
    maxTimeoutSeconds: 300,
  } as const;
  const verdictDescription =
    "Pre-trade token risk verdict: proceed, caution, or abort, with a safe position size and confidence.";
  const dossierDescription =
    "Full due-diligence dossier on a token, returned as a shareable formatted report.";

  // Machine-readable parameter contract, served in the body of the unpaid 402
  // (which the SDK otherwise leaves as `{}`). A caller that has never seen this
  // service — a marketplace validator, a buying agent — can discover exactly
  // what to send and what it will get back without paying first.
  const unpaidBody = (
    name: string,
    description: string,
    input: unknown,
    outputMimeType: string,
    outputDescription: string,
  ) => () => ({
    contentType: "application/json",
    body: {
      error: "Payment required",
      service: name,
      description,
      method: "GET or POST",
      parameters: "JSON body on POST, or query string on GET or POST",
      input,
      output: { mimeType: outputMimeType, description: outputDescription },
    },
  });
  // Every method that can reach a paid path is gated, not just POST: x402
  // validators and availability probes use GET and HEAD, and an unpaid 2xx on
  // a paid path fails validation outright.
  const pay = paymentMiddleware(
    {
        ...Object.fromEntries(
          ["POST", "GET", "HEAD"].map((m) => [
            `${m} /verdict`,
            {
              accepts: verdictAccepts,
              resource: `${config.publicOrigin}/verdict`,
              description: verdictDescription,
              mimeType: "application/json",
              extensions: httpInputSchema(
                verdictInputSchema,
                "application/json",
                "Decision object: verdict, maxSizeUsd, confidence, reasons, per-check results.",
              ),
              unpaidResponseBody: unpaidBody(
                "Pre-Trade Token Verdict",
                verdictDescription,
                verdictInputSchema,
                "application/json",
                "Decision object: verdict, maxSizeUsd, confidence, reasons, per-check results.",
              ),
            },
          ]),
        ),
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
        console.log("[x402] facilitator ready");
        return;
      } catch (e) {
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
        if (receipt && receipt.transaction) archive.linkTransaction(h, String(receipt.transaction));
      } catch {
        /* recovery is best effort and must never disturb the response */
      }
    };
    try {
      // pay() returns a Response for the unpaid 402 path and undefined once a
      // verified payment has run the handler — both must be passed through
      // unchanged, or Hono reports the context as unfinalized.
      const res = await pay(c, trackedNext);
      linkSettlement();
      return res;
    } catch (e) {
      if (handlerStarted) throw e;
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await pay(c, next);
        linkSettlement();
        return res;
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
          { error: "payment layer temporarily unavailable — no payment was taken, retry shortly" },
          503,
        );
      }
    }
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
function downloadName(d: { token: { symbol?: string; chain: string; address: string } }, json: boolean): string {
  const label = (d.token.symbol || d.token.address.slice(0, 10)).replace(/[^A-Za-z0-9._-]/g, "");
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

app.on(["GET", "POST"], "/verdict", async (c) => {
  // Reached only after the middleware has verified payment (or in dev-skip mode).
  const parsed = VerdictRequest.safeParse(await readParams(c));
  if (!parsed.success) {
    return invalid(c, parsed.error.issues);
  }
  try {
    const verdict = await evaluate(parsed.data);
    return c.json(verdict);
  } catch (e) {
    if (e instanceof SourcesUnavailableError) {
      // Non-2xx: the middleware does not settle, so an outage never charges the
      // buyer even though their payment was already verified upstream.
      c.header("Retry-After", "30");
      return c.json({ error: "data sources temporarily unavailable — retry shortly" }, 503);
    }
    throw e;
  }
});

app.on(["GET", "POST"], "/dossier", async (c) => {
  // Reached only after the middleware has verified payment (or in dev-skip mode).
  const parsed = DossierRequest.safeParse(await readParams(c));
  if (!parsed.success) {
    return invalid(c, parsed.error.issues);
  }
  try {
    const dossier = await buildDossier(parsed.data);
    const json = parsed.data.format === "json";
    const body = json ? JSON.stringify(dossier) : renderDossierHtml(dossier);
    // Archive before responding, and remember the key so the settlement
    // transaction can be attached once the SDK has settled.
    const id = archive.newId();
    const jobId = internalJobId(c);
    archive.save({
      id,
      paramsSha256: archive.paramsHash(parsed.data as Record<string, unknown>),
      request: parsed.data as Record<string, unknown>,
      contentType: json ? "application/json" : "text/html",
      deliverable: body,
      deliveredAt: new Date().toISOString(),
      ...(jobId ? { jobId } : {}),
    });
    (c as any).set("archiveId", id);
    // Name the artefact. Without this the marketplace saved an HTML report as a
    // .txt file, and a buyer's first sight of the deliverable was a text blob.
    // `inline` so browsers still render it; the filename is only used on save.
    c.header("Content-Disposition", `inline; filename="${downloadName(dossier, json)}"`);
    return json
      ? c.json(dossier)
      : c.html(body);
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
      return c.json({ error: "data sources temporarily unavailable — retry shortly" }, 503);
    }
    throw e;
  }
});
