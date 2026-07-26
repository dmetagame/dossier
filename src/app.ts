import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-hono";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { config, paymentConfigured } from "./config";
import { VerdictRequest, SUPPORTED_CHAINS } from "./verdict/schema";
import { evaluate, SourcesUnavailableError } from "./verdict/engine";
import {
  DossierRequest,
  buildDossier,
  ChainAmbiguousError,
  ChainNotFoundError,
} from "./dossier/report";
import { renderDossierHtml } from "./dossier/render";

export const app = new Hono();

app.get("/", (c) =>
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
      "Optional. Auto-detected when the address trades on exactly one supported chain; required when it is ambiguous.",
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
      method: "POST",
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
    try {
      return await pay(c, trackedNext);
    } catch (e) {
      if (handlerStarted) throw e;
      await new Promise((r) => setTimeout(r, 500));
      return await pay(c, next);
    }
  });
}

// A GET that gets past the gate still cannot name a token, so it answers 400
// (never 2xx): the middleware settles only on success, so a probe or a curious
// browser is never charged, and the path never reports itself as non-x402.
const getNeedsPost = (c: any) =>
  c.json(
    {
      error: "this endpoint takes a POST with a JSON body",
      usage: { method: "POST", body: { tokenAddress: "0x…", chain: "(optional)" } },
      freeSample: "/dossier/sample",
    },
    400,
  );
app.get("/verdict", getNeedsPost);
app.get("/dossier", getNeedsPost);

app.post("/verdict", async (c) => {
  // Reached only after the middleware has verified payment (or in dev-skip mode).
  const parsed = VerdictRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
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

app.post("/dossier", async (c) => {
  // Reached only after the middleware has verified payment (or in dev-skip mode).
  const parsed = DossierRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  }
  try {
    const dossier = await buildDossier(parsed.data);
    if (parsed.data.format === "json") return c.json(dossier);
    return c.html(renderDossierHtml(dossier));
  } catch (e) {
    // Non-2xx responses are never settled, so none of these charge the buyer.
    if (e instanceof ChainAmbiguousError) {
      return c.json({ error: e.message, candidates: e.candidates }, 400);
    }
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
