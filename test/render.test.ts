// The report is the product. It is a self-contained document that gets shared
// and printed, so: no external assets, no injected markup, no scientific
// notation in a price, and no claim of a source that did not answer.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderDossierHtml } from "../src/dossier/render";
import type { Dossier } from "../src/dossier/report";

const base = (over: Partial<Dossier> = {}): Dossier =>
  ({
    title: "Due-Diligence Dossier — TEST",
    generatedAt: "2026-07-27T00:00:00.000Z",
    token: {
      chain: "bsc",
      address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
      symbol: "TEST",
      priceUsd: 1.4,
      liquidityUsd: 16_358_687,
      deepestPoolUsd: 3_879_033,
      volume24hUsd: 1_527_050,
      ageDays: 1213,
      holderCount: 1_913_040,
    },
    riskVerdict: {
      verdict: "caution",
      maxSizeUsd: 19_395,
      confidence: 1,
      reasons: ["Contract control risk: mintable by active owner."],
      checks: {
        honeypot: { status: "warn", detail: "No honeypot flag." },
        contractControl: { status: "warn", detail: "mintable by active owner" },
        liquidity: { status: "pass", detail: "Pooled liquidity $16358687." },
        marketActivity: { status: "pass", detail: "24h volume $1527050." },
        holderConcentration: { status: "pass", detail: "Top 10 hold 3%." },
      },
      token: {} as never,
      meta: { sources: ["goplus", "dexscreener"], generatedAt: "", latencyMs: 1 },
    },
    security: { openSource: true, mintable: true, topHolderPct: 2.7 },
    sources: ["GoPlus", "DexScreener"],
    chainResolution: { source: "specified", ambiguous: false, alternatives: [] },
    ...over,
  }) as Dossier;

describe("self-contained", () => {
  test("loads nothing from anywhere else", () => {
    const html = renderDossierHtml(base());
    assert.equal(/<script/i.test(html), false, "no scripts in a document that gets printed");
    assert.equal(/https?:\/\/[^"']*\.(?:js|css|woff2?|png|jpg)/i.test(html), false);
    assert.equal(/@font-face/i.test(html), false, "the report stays on a system stack");
  });

  test("is a complete document", () => {
    const html = renderDossierHtml(base());
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.trimEnd().endsWith("</html>"));
  });
});

describe("untrusted values are escaped", () => {
  test("a hostile title cannot inject markup", () => {
    // The title is built from the symbol the market source reported, so it is
    // the field an attacker actually controls.
    const html = renderDossierHtml(
      base({ title: 'Dossier <img src=x onerror=alert(1)>' }),
    );
    assert.equal(html.includes("<img src=x"), false);
    assert.ok(html.includes("&lt;img src=x"));
  });

  test("a hostile check detail cannot break out of the table", () => {
    const d = base();
    d.riskVerdict.checks.liquidity.detail = '</td></tr><script>alert(1)</script>';
    const html = renderDossierHtml(d);
    assert.equal(/<script>/i.test(html), false);
  });

  test("the address is escaped too", () => {
    const html = renderDossierHtml(base({ token: { ...base().token, address: '"><b>x' } as never }));
    assert.equal(html.includes('"><b>x'), false);
  });
});

describe("figures", () => {
  test("a tiny price renders as a decimal, never as 1.2e-8", () => {
    const html = renderDossierHtml(base({ token: { ...base().token, priceUsd: 0.000000012 } as never }));
    assert.equal(/e-\d/i.test(html), false, "no scientific notation in a price a human reads");
    assert.ok(html.includes("0.000000012"));
  });

  test("missing figures render as an em dash rather than zero", () => {
    const html = renderDossierHtml(
      base({ token: { chain: "bsc", address: "0xabc" } as never }),
    );
    assert.ok(html.includes("—"));
    assert.equal(html.includes("$0</div>"), false);
  });
});

describe("wording holds the product's claims", () => {
  test("coverage is labelled coverage, not confidence", () => {
    const html = renderDossierHtml(base());
    assert.ok(html.includes("data coverage"));
    assert.equal(/confidence \d+%/.test(html), false);
    // The sentence wraps in the source, so compare on collapsed whitespace.
    assert.ok(html.replace(/\s+/g, " ").includes("not a probability that the token is safe"));
  });

  test("the size cap is labelled a heuristic and states its formula", () => {
    const html = renderDossierHtml(base());
    assert.ok(html.includes("Heuristic size cap"));
    assert.ok(html.includes("1% of the deepest pool"));
    assert.ok(html.includes("not a slippage guarantee"));
    assert.equal(html.includes("Safe max size"), false);
  });

  test("both liquidity figures are shown, so the cap can be checked", () => {
    const html = renderDossierHtml(base());
    assert.ok(html.includes("Liquidity (all pools)"));
    assert.ok(html.includes("Deepest pool"));
  });

  test("a valid signature is not confused with a trusted Dossier issuer", () => {
    const d = base({
      attestation: {
        payload: {
          schemaVersion: "dossier-attestation/2",
          methodologyVersion: "engine/2026-08-03",
          reportId: "report-1",
          requestSha256: "a".repeat(64),
          reportSha256: "b".repeat(64),
          token: { chain: "bsc", address: "0xabc" },
          result: { verdict: "caution", coverage: 1, maxSizeUsd: 1, checks: {} },
          observations: [],
          issuedAt: "2026-08-13T00:00:00.000Z",
          issuer: { agentId: 7012, name: "Dossier" },
        },
        payloadSha256: "c".repeat(64),
        signature: "signature",
        publicKey: "public-key",
        algorithm: "ed25519",
        verifyWith: "https://dossier.rouma.xyz/verify",
      },
    } as never);
    const html = renderDossierHtml(d);
    assert.ok(html.includes("holder of that key signed"));
    assert.ok(html.includes("code-reviewed trust registry"));
    assert.equal(html.includes("valid signature proves who issued"), false);
  });

  test("a multi-chain address is disclosed, not silently chosen", () => {
    const html = renderDossierHtml(
      base({ chainResolution: { source: "auto-detected", ambiguous: true, alternatives: ["ethereum"] } }),
    );
    assert.ok(/deployed on more than one chain/i.test(html));
    assert.ok(html.includes("ethereum"));
  });

  test("chain-read facts are shown and labelled as evidence, not proof", () => {
    const html = renderDossierHtml(
      base({
        contract: {
          isContract: true,
          name: "USD₮0",
          symbol: "USD₮0",
          decimals: 6,
          totalSupply: 112_526_175,
          proxyImplementation: "0x1ec7df9e74be05cb5a456aca2dc1ac2cec9ab6a3",
          owner: "0x4dff9b5b0143e642a3f63a5bcf2d1c328e600bf8",
          capabilities: ["mint", "ownable"],
        },
      } as never),
    );
    assert.ok(html.includes("On-chain identity"));
    assert.ok(html.includes("112,526,175"));
    assert.ok(html.includes("0x1ec7df9e74be05cb5a456aca2dc1ac2cec9ab6a3"));
    assert.ok(html.replace(/\s+/g, " ").includes("evidence rather than proof"));
  });

  test("a report without chain facts simply omits that section", () => {
    assert.equal(renderDossierHtml(base()).includes("On-chain identity"), false);
  });

  test("the sample banner appears only when asked for", () => {
    assert.equal(renderDossierHtml(base()).includes("class=\"banner\""), false);
    assert.ok(renderDossierHtml(base(), { banner: "Sample report" }).includes("Sample report"));
  });
});

// A lock too small to round to a whole percent renders "<1%", which is the only
// value in the contract-and-distribution block that can begin with "<".
// Unescaped, the browser swallowed the rest of the row and it rendered blank —
// a real lock disappearing from the report that is supposed to show it.
describe("the LP lock row survives being rendered", () => {
  const rowOf = (html: string): string =>
    html.match(/LP locked \(main pool\)<\/span><span>([^<]*(?:<(?!\/span>)[^<]*)*)<\/span>/)?.[1] ?? "";

  test("a sub-percent lock is escaped, not swallowed", () => {
    const html = renderDossierHtml(base({ security: { lpLockedPct: 0.00913 } }));
    assert.equal(rowOf(html), "&lt;1%");
    assert.doesNotMatch(html, /<span><1%/, "a raw < opens a tag the parser never closes");
  });

  test("an ordinary lock still renders as a percentage", () => {
    assert.equal(rowOf(renderDossierHtml(base({ security: { lpLockedPct: 45.4 } }))), "45.4%");
  });

  test("a lock we could not establish renders as unknown, not zero", () => {
    assert.equal(rowOf(renderDossierHtml(base({ security: {} }))), "—");
  });

  // A row saying only "100%" invites the reader to supply a permanence nobody
  // checked. MOG's lock runs to 2092 through UNCX, and both facts are ours to
  // print — the share reached the row while the expiry sat unused in the source.
  test("the expiry and the locker travel with the share", () => {
    const html = renderDossierHtml(
      base({ security: { lpLockedPct: 99.99, lpLockedUntil: "2092-09-20", lpLockedVia: "UNCX" } }),
    );
    assert.equal(rowOf(html), "100.0% until 2092-09-20 (UNCX)");
  });

  test("a lock with no stated expiry claims none", () => {
    const html = renderDossierHtml(base({ security: { lpLockedPct: 99.99 } }));
    assert.equal(rowOf(html), "100.0%");
    assert.doesNotMatch(html, /until undefined/);
  });

  // The label carries the scope. `lp_holders` describes one pool's LP token, so
  // a token trading across thirty pairs has twenty-nine this says nothing about.
  test("the row names the pool it is actually about", () => {
    assert.match(renderDossierHtml(base({ security: { lpLockedPct: 50 } })), /LP locked \(main pool\)/);
  });
});
