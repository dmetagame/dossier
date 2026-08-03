// The landing page at GET /.
//
// Design decision, stated so it is not re-litigated by accident: this page is
// set as a *document*, not as a dark product page. The thing being sold is an
// executive-ready report that prints to PDF, and the report renderer
// (src/dossier/render.ts) is a light page on #fbfcfe with three verdict
// colours. The landing page previously used an unrelated dark indigo scheme
// with a periwinkle accent that appears nowhere in the product, which is both
// generic and a split identity. It now takes its palette from the report,
// exactly: --ink, --muted, --line, and the proceed/caution/unavailable colours.
//
// Typefaces deliberately diverge from the report. The report must stay a
// self-contained document with zero external assets, so it keeps a system
// stack; webfonts there would either break that guarantee or add weight to
// every paid response. Same palette and register, different face, on purpose.

import { FONT_FACE_CSS, FONTS } from "./fonts";
import { HERO_BUNDLE } from "./generated/hero-bundle";

// Five stations on a 420-unit ring, clockwise from the top. Index 3 is the one
// that lands `unavailable`; holder data is the field our sources most often
// cannot answer, so it is the honest one to illustrate.
//
// Labels sit on a wider radius than the dots (37.6% vs 28.6% of the box) and
// anchor away from the ring, so a label never covers the station it names.
const ANGLES = [-90, -18, 54, 126, 198];
const STATIONS = [
  { label: "sellability", x: 50.0, y: 12.4, anchor: "c" },
  { label: "contract control", x: 85.8, y: 38.4, anchor: "l" },
  { label: "liquidity", x: 72.1, y: 80.4, anchor: "l" },
  { label: "holders", x: 27.9, y: 80.4, anchor: "r" },
  { label: "market activity", x: 14.2, y: 38.4, anchor: "r" },
];

const HERO_SVG = `
<svg class="h-svg" viewBox="0 0 420 420" aria-hidden="true" focusable="false">
  <circle class="h-track" cx="210" cy="210" r="120"/>
  <path class="h-ring-arc" d="M210 90 A120 120 0 1 1 209.9 90"/>
  ${ANGLES.map(
    (a, i) => `<g transform="translate(210 210) rotate(${a})">
    <line class="h-probe" x1="0" y1="0" x2="120" y2="0"/>
    <circle class="h-dot${i === 3 ? " is-unavailable" : ""}" cx="120" cy="0" r="6.5"/>
  </g>`,
  ).join("\n  ")}
</svg>`;

const HERO_HTML = `
<figure class="hero-viz" role="img"
  aria-label="Illustration of one run: five checks are dispatched, four resolve, one source is unavailable, and the verdict is caution at eighty percent coverage.">
  ${HERO_SVG}
  <div class="h-centre" aria-hidden="true">
    <div class="h-addr">0x0e09…1cE82</div>
    <div class="h-verdict">caution</div>
    <div class="h-figs">
      <span class="h-fig">coverage <b>80%</b></span>
      <span class="h-fig">1 source unavailable</span>
    </div>
  </div>
  <div class="h-labels" aria-hidden="true">
    ${STATIONS.map(
      (s, i) =>
        `<span class="h-label a-${s.anchor}${i === 3 ? " is-unavailable" : ""}" style="--lx:${s.x}%;--ly:${s.y}%">` +
        `<i class="h-ldot"></i>${s.label}</span>`,
    ).join("\n    ")}
  </div>
</figure>`;

const CSS = `
${FONT_FACE_CSS}
:root{
  /* Pulled from src/dossier/render.ts so the page and the product it sells
     cannot drift apart. */
  --ink:#141a24; --muted:#5b6472; --line:#e4e8ee; --bg:#fbfcfe; --paper:#fff;
  --proceed:#1c8f5a; --caution:#b7791f; --abort:#c02b2b; --unavailable:#8a94a6;
  --serif:"Instrument Serif",Georgia,"Times New Roman",serif;
  --sans:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:1rem/1.6 var(--sans);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--ink);text-underline-offset:3px;text-decoration-thickness:1px}
b,strong{font-weight:600}
.wrap{max-width:1060px;margin:0 auto;padding:0 28px}

/* type scale */
.eyebrow{font:600 .75rem/1 var(--mono);text-transform:uppercase;letter-spacing:.12em;
  color:var(--muted)}
h1{font:400 clamp(2.75rem,6vw,5.5rem)/0.95 var(--serif);letter-spacing:-.03em;
  margin:.5rem 0 0;max-width:15ch}
h2{font:400 clamp(1.75rem,3vw,2.75rem)/1.1 var(--serif);letter-spacing:-.02em;margin:0 0 1.25rem}
h3{font:600 1rem/1.4 var(--sans);margin:0 0 .4rem;letter-spacing:-.01em}
.lede{font-size:1.0625rem;color:var(--muted);max-width:58ch;margin:1.5rem 0 0}
.caption{font-size:.8125rem;color:var(--muted)}
.num,.h-fig b,td.n{font-family:var(--mono);font-variant-numeric:tabular-nums}

header{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  padding:1.75rem 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.6rem;font:600 1.0625rem/1 var(--sans);
  letter-spacing:-.02em}
.mark{width:26px;height:26px;border:1.5px solid var(--ink);border-radius:4px;
  display:grid;place-items:center;font:600 .8125rem/1 var(--mono)}
.tag{font:.75rem/1 var(--mono);color:var(--muted);border:1px solid var(--line);
  border-radius:999px;padding:.45rem .75rem}

.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:3rem;align-items:center;
  padding:2rem 0 3.5rem}
.cta{display:flex;gap:.6rem;flex-wrap:wrap;margin:2rem 0 .9rem}
.btn{display:inline-block;padding:.7rem 1.15rem;border-radius:7px;text-decoration:none;
  font:500 .9375rem/1.2 var(--sans);border:1px solid var(--ink)}
.btn.p{background:var(--ink);color:var(--bg)}
.btn.s{border-color:var(--line);color:var(--ink)}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:3px}

/* hero figure: reserves its space before paint, so nothing shifts */
.hero-viz{position:relative;margin:0;width:100%;max-width:440px;justify-self:end;
  aspect-ratio:1/1}
.h-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.h-track{fill:none;stroke:var(--line);stroke-width:1}
.h-ring-arc{fill:none;stroke:var(--caution);stroke-width:2.5;stroke-linecap:butt;
  transform:rotate(-0.0001deg)}
.h-probe{stroke:var(--line);stroke-width:1.5}
.h-dot{fill:var(--proceed)}
.h-dot.is-unavailable{fill:var(--unavailable)}
.h-centre{position:absolute;inset:0;display:grid;place-content:center;text-align:center;gap:.35rem}
.h-addr{font:.8125rem/1 var(--mono);color:var(--muted);letter-spacing:.02em}
.h-verdict{font:400 2rem/1 var(--serif);color:var(--caution);letter-spacing:-.02em}
.h-figs{display:flex;flex-direction:column;gap:.15rem}
.h-fig{font:.75rem/1.5 var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}
.h-labels{position:absolute;inset:0}
.h-labels{overflow:visible}
.h-label{position:absolute;left:var(--lx);top:var(--ly);
  font:.75rem/1 var(--mono);color:var(--muted);white-space:nowrap;
  display:flex;align-items:center;gap:.4rem}
.h-label.a-c{transform:translate(-50%,-50%)}
.h-label.a-l{transform:translate(0,-50%)}
.h-label.a-r{transform:translate(-100%,-50%)}
.h-ldot{width:6px;height:6px;border-radius:50%;background:var(--proceed);display:none}
.h-label.is-unavailable .h-ldot{background:var(--unavailable)}

section{padding:3.5rem 0;border-top:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.5rem}
.card p{margin:0;color:var(--muted);font-size:.9375rem}
pre{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:1.1rem;
  overflow-x:auto;font:.8125rem/1.7 var(--mono);margin:0 0 .9rem}
code{font-family:var(--mono);font-size:.9em}
.k{color:var(--caution)}.s{color:var(--proceed)}.c{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:.9375rem}
td{padding:.85rem 0;border-top:1px solid var(--line);vertical-align:top}
td:first-child{color:var(--muted);width:34%;padding-right:1.5rem}
footer{padding:2.5rem 0 4rem;border-top:1px solid var(--line);color:var(--muted);
  font-size:.8125rem}
.addr{font-family:var(--mono);word-break:break-all;font-size:.75rem}

@media (max-width:900px){
  .hero{grid-template-columns:1fr;gap:2.5rem;padding-bottom:2.5rem}
  .hero-viz{justify-self:center;max-width:380px}
}
/* Below 640 the ring tightens and the labels leave it entirely, stacking into
   a legible column. Shrinking the ring alone would make five rotated labels
   collide. */
@media (max-width:640px){
  /* The ring tightens and keeps the arc; the five stations leave it and stack
     as a legible column beside it, with the verdict block below spanning both.
     Five rotated labels around a 150px ring would collide. */
  .hero-viz{max-width:none;aspect-ratio:auto;display:grid;gap:1rem 1.25rem;
    grid-template-columns:132px 1fr;grid-template-areas:"ring labels" "centre centre";
    align-items:center;justify-self:stretch}
  .h-svg{position:relative;grid-area:ring;width:132px;height:132px;overflow:hidden}
  .h-svg .h-probe,.h-svg .h-dot{display:none}
  .h-centre{position:relative;inset:auto;grid-area:centre;place-content:center;gap:.25rem}
  .h-labels{position:static;inset:auto;grid-area:labels;display:flex;
    flex-direction:column;gap:.5rem;align-items:flex-start}
  .h-label,.h-label.a-c,.h-label.a-l,.h-label.a-r{position:static;left:auto;top:auto;
    transform:none;padding:0}
  .h-ldot{display:block;flex:none}
  .h-verdict{font-size:1.75rem}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
}`;

/** The exact bytes served inside <script>, so the CSP can allow it by hash. */
export const SITE_INLINE = HERO_BUNDLE.replace(/<\//g, "<\\/");

export function renderSiteHtml(opts: { price: string; agentId: number }): string {
  const { price, agentId } = opts;
  // Inlined script: escape any "</" so a literal </script> in the bundle cannot
  // close the tag early.
  const inline = SITE_INLINE;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dossier — token due diligence, one paid call</title>
<meta name="description" content="One call returns a finished due-diligence report on any token: risk verdict, a heuristic position-size cap, security flags, liquidity, market activity and holder concentration. Paid per call over x402 on X Layer.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23fbfcfe'/%3E%3Cpath d='M20 14h18l8 8v28H20z' fill='none' stroke='%23141a24' stroke-width='4'/%3E%3C/svg%3E">
<link rel="preload" href="${FONTS.serif!.path}" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body>
<div class="wrap">

  <header>
    <div class="brand"><span class="mark">D</span> Dossier</div>
    <div class="tag">Live on OKX.AI · agent #${agentId}</div>
  </header>

  <div class="hero">
    <div>
      <div class="eyebrow">Due diligence · X Layer</div>
      <h1>Token due diligence, in one paid call.</h1>
      <p class="lede">Send a contract address. Get back a finished, shareable report: a clear risk
        verdict, a heuristic size cap, security flags, liquidity depth, market activity and holder
        concentration, compiled from live on-chain data rather than opinions.</p>
      <div class="cta">
        <a class="btn p" href="/dossier/sample">Read a real report</a>
        <a class="btn s" href="#use">How to call it</a>
      </div>
      <p class="caption">The sample is a genuine report generated on request. No signup, nothing to install.</p>
    </div>
    ${HERO_HTML}
  </div>

  <section>
    <h2>What one call returns</h2>
    <div class="grid">
      <div class="card"><h3>A decision, not a data dump</h3>
        <p>Proceed, caution or abort, with a heuristic size cap in USD and a coverage score you can act on.</p></div>
      <div class="card"><h3>Five risk checks</h3>
        <p>Sellability, contract control, liquidity depth, market activity and holder concentration, each pass, warn or fail with the reason.</p></div>
      <div class="card"><h3>A document, not JSON</h3>
        <p>A self-contained page you can read, share or print to PDF. Ask for <code>format:"json"</code> if a machine is reading it.</p></div>
      <div class="card"><h3>Deterministic</h3>
        <p>No language model anywhere in the analysis. The same token and the same data produce the same report, every time.</p></div>
    </div>
  </section>

  <section id="use">
    <h2>Call it</h2>
    <pre><span class="c"># check coverage first, free, no payment</span>
curl <span class="s">"https://dossier.rouma.xyz/dossier/preflight?tokenAddress=0x0e09…1cE82"</span>

<span class="c"># the paid call returns an x402 challenge, then the report</span>
curl -X POST <span class="s">https://dossier.rouma.xyz/dossier</span> \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"<span class="k">tokenAddress</span>":"0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"}'</span></pre>
    <p class="caption">The payment challenge carries the input contract, so an agent discovers what to
      send before it authorises payment. Buying agents on OKX.AI handle the payment automatically.
      <code>chain</code> is optional: it is detected from live markets, and when an address exists on
      several chains the deepest-liquidity deployment is analysed and the report says which it used.</p>
  </section>

  <section>
    <h2>Terms</h2>
    <table>
      <tr><td>Price</td><td class="n">${price} per call, USD₮0 on X Layer</td></tr>
      <tr><td>Payment</td><td>x402 v2 via the official OKX Payment SDK, settled on-chain</td></tr>
      <tr><td>Chains</td><td>Ethereum, BNB Chain, Base, Arbitrum, Polygon, X Layer</td></tr>
      <tr><td>Sources</td><td>GoPlus security data and DexScreener markets, live at request time</td></tr>
      <tr><td>Failures</td><td>Never charged. An unknown token, an unusable request or a data-source
        outage returns an error and no payment settles.</td></tr>
      <tr><td>Coverage</td><td>When a source cannot answer, the affected checks are marked unknown and
        the coverage score drops. Gaps are stated, never filled in.</td></tr>
    </table>
  </section>

  <footer>
    Dossier · OKX.AI agent #${agentId} · payouts to
    <span class="addr">0x51c25782af63381056cd1c3c59c0544628d67697</span><br>
    Machine-readable service description at <a href="/info">/info</a> ·
    free sample at <a href="/dossier/sample">/dossier/sample</a> ·
    coverage preflight at <a href="/dossier/preflight?tokenAddress=0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82">/dossier/preflight</a>
  </footer>

</div>
<script>${inline}</script>
</body></html>`;
}
