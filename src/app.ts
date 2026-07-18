import { Hono } from "hono";
import { config } from "./config.js";
import { buildChallenge, verifyPayment } from "./x402.js";
import { VerdictRequest } from "./verdict/schema.js";
import { evaluate } from "./verdict/engine.js";

export const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "Verdict",
    description:
      "Pre-transaction verdict engine for AI agents: send a token, get a decision — proceed/caution/abort, a safe position size, and confidence — computed from live security and market data.",
    endpoint: { path: "/verdict", method: "POST", pricing: `${config.priceUsdt} ${config.assetSymbol} per call (x402)` },
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    devSkipPayment: config.devSkipPayment,
    paymentConfigured: Boolean(config.assetAddress && config.payTo),
  }),
);

app.post("/verdict", async (c) => {
  const paid = await verifyPayment(c.req.raw);
  if (!paid) {
    const { headerValue, body } = buildChallenge();
    c.header("PAYMENT-REQUIRED", headerValue);
    return c.json(body, 402);
  }
  const parsed = VerdictRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  }
  const verdict = await evaluate(parsed.data);
  return c.json(verdict);
});
