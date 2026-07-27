import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-hono";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { config, paymentConfigured } from "./config";
import { VerdictRequest, SUPPORTED_CHAINS } from "./verdict/schema";
import { evaluate, SourcesUnavailableError } from "./verdict/engine";
import { DossierRequest, buildDossier, ChainNotFoundError } from "./dossier/report";
import { renderDossierHtml } from "./dossier/render";
import * as archive from "./dossier/archive";
import { renderSiteHtml } from "./site";

export const app = new Hono();

// Human landing page at the root; the same information stays machine-readable
// at /info for agents and crawlers that want structure rather than markup.
app.get("/", (c) =>
  c.html(renderSiteHtml({ price: config.dossierPrice, agentId: 7012 })),
);

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

// Recovery: a buyer who lost the paid response can fetch it again. Free —
// they have already paid — but it requires the settlement transaction hash,
// which only the payer can know, so this can never yield a report to someone
// who did not buy one. Supplying the original parameters (or their hash) is
// accepted as a second check and returns the same archived bytes.
app.on(["GET", "POST"], "/dossier/recovery", async (c) => {
  const p = await readParams(c);
  const tx = String(p.paymentTransaction || p.transaction || "").trim();
  const givenHash = String(p.requestParamsSha256 || p.requestBodySha256 || "").trim();
  let originalBody = p.originalBody as Record<string, unknown> | undefined;
  if (typeof originalBody === "string") {
    try { originalBody = JSON.parse(originalBody); } catch { originalBody = undefined; }
  }

  // The settlement transaction is required, and deliberately so. The request
  // parameters hash to a value anyone could derive for a popular token, so
  // accepting that alone would hand a paid report to someone who never bought
  // one. Only the payer knows the transaction.
  if (!tx) {
    return c.json(
      {
        error: "missing_proof_of_purchase",
        message:
          "Send paymentTransaction: the settlement transaction hash from your paid call, " +
          "found in the PAYMENT-RESPONSE header of the response you received. " +
          "originalBody or requestParamsSha256 may be sent as an additional check.",
        usage: {
          post: 'POST /dossier/recovery {"paymentTransaction":"0x…"}',
          get: "GET /dossier/recovery?paymentTransaction=0x…",
        },
      },
      400,
    );
  }

  const hash = givenHash || (originalBody ? archive.paramsHash(originalBody) : "");
  const rec = archive.byTransaction(tx);

  if (!rec) {
    return c.json(
      {
        error: "not_found_in_archive",
        message:
          "No delivered report matches that transaction or request. If the paid call never " +
          "reached this service, no report was produced and no payment was settled.",
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
    requestParamsSha256: rec.paramsSha256,
    request: rec.request,
    deliveredAt: rec.deliveredAt,
    recoveredAt: new Date().toISOString(),
    contentType: rec.contentType,
    deliverable: rec.contentType === "application/json" ? JSON.parse(rec.deliverable) : rec.deliverable,
  });
});

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
  const chainEnum = [...SUPPORTED_CHAINS];
  const tokenAddressSchema = {
    type: "string",
    pattern: "^0x[a-fA-F0-9]{40}$",
    description: "EVM token contract address.",
  } as const;
  const chainSchema = {
    type: "string",
    enum: chainEnum,
    description:
      "Optional. Auto-detected from live markets; when the address is deployed on several chains the deepest-liquidity deployment is analysed and the report states which chain was used.",
  } as const;
  const dossierInputSchema = {
    type: "object",
    properties: {
      tokenAddress: tokenAddressSchema,
      chain: chainSchema,
      format: {
        type: "string",
        enum: ["html", "json"],
        default: "html",
        description: "html returns the rendered report document; json returns the same data structured.",
      },
    },
    required: ["tokenAddress"],
    additionalProperties: false,
  } as const;
  const verdictInputSchema = {
    type: "object",
    properties: {
      tokenAddress: tokenAddressSchema,
      chain: chainSchema,
      amountUsd: { type: "number", description: "Optional intended position size in USD." },
    },
    required: ["tokenAddress"],
    additionalProperties: false,
  } as const;
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
              description: verdictDescription,
              mimeType: "application/json",
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
              description: dossierDescription,
              mimeType: "text/html",
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
  );
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
    if (config.internalKey && c.req.header("x-internal-key") === config.internalKey) {
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
        const h = (c as any).get("archiveHash");
        const pr = c.res && c.res.headers.get("payment-response");
        if (!h || !pr) return;
        const receipt = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
        if (receipt && receipt.transaction) archive.linkTransaction(h, String(receipt.transaction));
      } catch {
        /* recovery is best effort and must never disturb the response */
      }
    };
    try {
      await pay(c, trackedNext);
      linkSettlement();
      return;
    } catch (e) {
      if (handlerStarted) throw e;
      await new Promise((r) => setTimeout(r, 500));
      await pay(c, next);
      linkSettlement();
      return;
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
    const hash = archive.paramsHash(parsed.data as Record<string, unknown>);
    archive.save({
      paramsSha256: hash,
      request: parsed.data as Record<string, unknown>,
      contentType: json ? "application/json" : "text/html",
      deliverable: body,
      deliveredAt: new Date().toISOString(),
    });
    (c as any).set("archiveHash", hash);
    return json
      ? c.json(dossier)
      : c.html(body);
  } catch (e) {
    // Non-2xx responses are never settled, so none of these charge the buyer.
    if (e instanceof ChainNotFoundError) {
      return c.json({ error: e.message }, 404);
    }
    if (e instanceof SourcesUnavailableError) {
      c.header("Retry-After", "30");
      return c.json({ error: "data sources temporarily unavailable — retry shortly" }, 503);
    }
    throw e;
  }
});
