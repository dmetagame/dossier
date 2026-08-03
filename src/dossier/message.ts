// The buyer-facing delivery message, generated here rather than written by
// whoever happens to be sending it.
//
// This exists because of one line that reached a real buyer on 2026-08-03:
//
//     VERDICT: CAUTION (confidence 100%) — safe position size ≈ $78,345
//
// for a token the very next line flagged as mintable with an unrenounced owner.
// The size cap is 1% of the deepest pool's base-side liquidity, halved on
// caution. It is not a safe position size, the report calls it a heuristic size
// cap, and the fulfilment watcher calls it that too. Only the delivery message
// called it safe, because that message was composed by a language model working
// from a prompt and a JSON blob, and the prompt used the wrong words.
//
// The product's claim is that there is no LLM anywhere and results are
// reproducible. A model paraphrasing the verdict into a buyer's inbox
// contradicts that claim in the one place the buyer actually reads. So the
// service emits the exact string, and every sender pastes it.
//
// What is deliberately NOT here: the encrypted attachment parameters. They come
// from an upload that happens after this text is generated, and they are
// mechanical key-value pairs with no prose to get wrong. Senders append that
// block; nobody edits what is above it.

import type { Dossier } from "./report";

const money = (n?: number | null): string =>
  n === undefined || n === null ? "n/a" : "$" + Math.round(n).toLocaleString("en-US");

// A sub-micro price must print as 0.000002932, never 2.932e-06: a buyer reading
// scientific notation in a chat message cannot tell it from a typo.
const price = (n?: number | null): string =>
  n === undefined || n === null || !Number.isFinite(n)
    ? "n/a"
    : "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 20 });

export interface MessageContext {
  /** Marketplace job this is being delivered into, if any. */
  jobId?: string;
  /** One-time recovery code minted for this delivery, if any. */
  recoveryCode?: string;
  /** Public URL of the paid endpoint, e.g. https://dossier.rouma.xyz/dossier */
  endpoint: string;
  /**
   * True when the token was resolved from a ticker rather than an address the
   * buyer gave us. Says so, so a mismatch is caught by the person who knows
   * which token they meant.
   */
  fromTicker?: boolean;
}

export function renderDeliveryMessage(d: Dossier, ctx: MessageContext): string {
  const v = d.riskVerdict;
  const t = d.token;
  const L: string[] = [];

  L.push(`DOSSIER REPORT - ${t.symbol ?? "token"} (${t.chain})`);
  L.push("");
  L.push(
    `VERDICT: ${String(v.verdict).toUpperCase()} | data coverage ${Math.round(
      (v.confidence ?? 0) * 100,
    )}% | heuristic size cap ${money(v.maxSizeUsd)}`,
  );
  L.push("");
  L.push("KEY FINDINGS:");
  for (const r of v.reasons ?? []) L.push("  - " + r);
  L.push("");
  L.push(
    `SNAPSHOT: price ${price(t.priceUsd)} | liquidity ${money(t.liquidityUsd)} | ` +
      `24h volume ${money(t.volume24hUsd)} | holders ${
        t.holderCount ? money(t.holderCount).slice(1) : "n/a"
      }`,
  );
  L.push(`CONTRACT: ${t.address}`);
  if (ctx.fromTicker) {
    L.push(
      "  (resolved from the ticker in the job title, by far the deepest token" +
        " trading under it. If you meant a different contract, reply with its" +
        " address and I will re-run this.)",
    );
  }
  L.push(`SOURCES: ${(d.sources ?? []).join(", ")}`);
  L.push("");
  L.push("ATTACHMENT_BLOCK");
  L.push("");

  if (ctx.jobId) {
    L.push("LOST THIS REPORT? Re-fetch the exact copy sent to you, free:");
    if (ctx.recoveryCode) {
      L.push(`  POST ${ctx.endpoint}/recovery  body {"jobId":"${ctx.jobId}",`);
      L.push(`    "recoveryCode":"${ctx.recoveryCode}"}`);
      L.push("  Keep that code. It is not stored here in a form we can read");
      L.push("  back to you, and this message is the only copy.");
    } else {
      L.push(`  POST ${ctx.endpoint}/recovery  body {"jobId":"${ctx.jobId}",`);
      L.push(
        `    "originalBody":{"tokenAddress":"${t.address}","chain":"${t.chain}"}}`,
      );
    }
    L.push("");
  }

  // NOTHING HERE MAY ASK A BUYER FOR MONEY.
  //
  // This block once said "TO CLOSE THIS TASK: re-run your x402 task payment".
  // It was written for one stalled buyer and then sent to every buyer, including
  // those whose payment had already settled, for whom it was simply false. An
  // automated message demanding a second payment is indistinguishable from a
  // scam, and it earned a 3-star review on 2026-08-02 saying exactly that.
  L.push("You owe nothing further for this report. This message never asks");
  L.push("for payment.");
  L.push("");
  L.push(`Endpoint, if you want the document outside the task: POST ${ctx.endpoint}`);
  L.push(`Report signed (ed25519), independently verifiable at ${ctx.endpoint.replace(/\/dossier$/, "/verify")}.`);

  return L.join("\n");
}
