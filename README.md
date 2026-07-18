# Verdict

Pre-transaction verdict engine for AI agents, sold as a paid A2MCP service on OKX.AI.

An agent about to transact sends a token; Verdict returns a **decision**, not a data dump:

```json
{
  "verdict": "caution",
  "maxSizeUsd": 68,
  "confidence": 1,
  "reasons": ["Pooled liquidity $13736 — shallow", "24h volume $2 — near-dead market", "Requested $500 exceeds the safe size — capped at $68"]
}
```

Five checks (sellability, contract control, liquidity, market activity, holder concentration) computed
from live GoPlus + DexScreener data, deterministic and benchmarkable. Payment is x402 v2:
unpaid `POST /verdict` returns a `402` with a `PAYMENT-REQUIRED` challenge (0.2 USDT on X Layer, `exact` scheme).

## Run

```bash
pnpm install
cp .env.example .env   # fill ASSET_ADDRESS + PAY_TO
NODE_OPTIONS=--dns-result-order=ipv4first DEV_SKIP_PAYMENT=1 pnpm dev
curl -X POST localhost:8787/verdict -H 'content-type: application/json' \
  -d '{"chain":"bsc","tokenAddress":"0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82","amountUsd":5000}'
```

`GET /health` reports whether payment gating is live (`devSkipPayment` must be `false` in prod).

## Open items (blocking before OKX.AI listing)

1. **Facilitator verification** — `verifyPayment` fails closed; wire the OKX facilitator verify/settle call. Docs at web3.okx.com/onchainos (unreachable from this dev box — read from deployed env or VPN).
2. **USDT contract address on X Layer** — confirm from OKX docs; deploy fails loudly without it.
3. **X Layer token coverage** — DexScreener has no X Layer pairs; wire OKX DEX market API as a source (callable only from the deployed region, OKX blocks this box's IP).
4. **Benchmark** — run the known-rug / known-legit token set and publish accuracy before claiming anything.
