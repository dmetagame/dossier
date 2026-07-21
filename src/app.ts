import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-hono";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { config, paymentConfigured } from "./config";
import { VerdictRequest } from "./verdict/schema";
import { evaluate, SourcesUnavailableError } from "./verdict/engine";
import { DossierRequest, buildDossier } from "./dossier/report";
import { renderDossierHtml } from "./dossier/render";

export const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "Verdict",
    description:
      "Pre-transaction verdict engine for AI agents: send a token, get a decision — proceed/caution/abort, a safe position size, and confidence — computed from live security and market data.",
    endpoint: { path: "/verdict", method: "POST", pricing: `${config.price} per call (x402 on X Layer)` },
  }),
);

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
  app.use(
    paymentMiddleware(
      {
        "POST /verdict": {
          accepts: {
            scheme: "exact",
            price: config.price,
            network: config.network,
            payTo: config.payTo,
            maxTimeoutSeconds: 300,
          },
          description:
            "Pre-trade token risk verdict: proceed, caution, or abort, with a safe position size and confidence.",
        },
        "POST /dossier": {
          accepts: {
            scheme: "exact",
            price: config.dossierPrice,
            network: config.network,
            payTo: config.payTo,
            maxTimeoutSeconds: 300,
          },
          description:
            "Full due-diligence dossier on a token, returned as a shareable formatted report.",
        },
      },
      resourceServer,
    ),
  );
}

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
    if (e instanceof SourcesUnavailableError) {
      c.header("Retry-After", "30");
      return c.json({ error: "data sources temporarily unavailable — retry shortly" }, 503);
    }
    throw e;
  }
});
