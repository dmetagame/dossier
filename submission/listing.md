# OKX.AI listing copy (drafted to survive their QA rules)

Constraints honored: agent name is a brand, 3 to 25 chars. Service name is a noun
phrase, 5 to 30 chars, no price. Service description is two parts on separate lines,
part 1 is capability and audience, part 2 is required inputs, no links, no tech-stack
names, no disclaimers, no example prompts. Fee is digits only, USDT implied.

## ASP identity

- **Name:** Verdict
- **Description (≤500):** Verdict is a pre-trade risk decision service for the agent
  economy. Before an agent or trader commits funds to a token, Verdict checks whether
  the token can be sold, whether the contract owner holds dangerous powers, how deep
  the liquidity is, how active the market is, and how concentrated the holders are,
  all on live data. It then returns a single actionable decision: proceed, caution,
  or abort, together with a safe position size and a confidence score.
- **Avatar:** required, square image. TODO: generate a simple gavel/checkmark mark.

## Service

- **Service name:** Pre-Trade Token Verdict
- **Description part 1:** Tells an AI agent or trader whether a token is safe to
  trade right now. Returns a clear verdict of proceed, caution, or abort, a safe
  position size in USD, a confidence score, and the decisive reasons.
- **Description part 2:** 1. Chain name 2. Token contract address 3. Optional:
  intended action and position size in USD
- **Type:** API service (A2MCP)
- **Fee:** 0.2
- **Endpoint:** https://TODO-production-url/verdict
