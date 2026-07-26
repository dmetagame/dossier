// Public landing page for dossier.rouma.xyz. Self-contained (no external
// assets or fonts) so it renders instantly and cannot break from a third-party
// outage — the same constraint the report itself is built under.

export function renderSiteHtml(opts: { price: string; agentId: number }): string {
  const { price, agentId } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dossier — token due diligence, one paid call</title>
<meta name="description" content="One call returns a finished due-diligence report on any token: risk verdict, safe position size, security flags, liquidity, market activity and holder concentration. Paid per call over x402 on X Layer.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230B1220'/%3E%3Cpath d='M20 14h18l8 8v28H20z' fill='none' stroke='%237C8CF8' stroke-width='4'/%3E%3C/svg%3E">
<style>
  :root{--bg:#0b1220;--panel:#121a2e;--line:#243154;--ink:#eaf0ff;--muted:#9aa8c7;
        --acc:#7c8cf8;--acc2:#5563e6;--ok:#3ecf8e;--warn:#f0b354;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:var(--acc)}
  .wrap{max-width:940px;margin:0 auto;padding:0 22px}
  header{padding:26px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:11px;font-weight:700;letter-spacing:-.01em;font-size:18px}
  .mark{width:30px;height:30px;border-radius:7px;background:linear-gradient(135deg,#7c8cf8,#5563e6);
    display:grid;place-items:center;color:#0b1220;font-weight:800;font-size:15px}
  .badge{font-size:12.5px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 11px}
  .hero{padding:34px 0 8px}
  h1{font-size:clamp(30px,5.2vw,50px);line-height:1.08;letter-spacing:-.025em;margin:0 0 16px;max-width:17ch}
  .lede{font-size:clamp(16px,2.1vw,19px);color:var(--muted);max-width:62ch;margin:0 0 26px}
  .cta{display:flex;gap:11px;flex-wrap:wrap;margin-bottom:12px}
  .btn{display:inline-block;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600;font-size:15px}
  .btn.p{background:linear-gradient(135deg,#7c8cf8,#5563e6);color:#0b1220}
  .btn.s{border:1px solid var(--line);color:var(--ink)}
  .note{font-size:13.5px;color:var(--muted);margin:0}
  section{padding:40px 0;border-top:1px solid var(--line);margin-top:40px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:0 0 18px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:17px}
  .card h3{margin:0 0 6px;font-size:15.5px}
  .card p{margin:0;color:var(--muted);font-size:14px}
  pre{background:#080d18;border:1px solid var(--line);border-radius:11px;padding:16px;overflow-x:auto;
    font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d4dcf5;margin:0 0 12px}
  .k{color:var(--acc)}.s{color:var(--ok)}.c{color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:14.5px}
  td{padding:11px 0;border-top:1px solid var(--line);vertical-align:top}
  td:first-child{color:var(--muted);width:42%;padding-right:16px}
  footer{padding:30px 0 50px;color:var(--muted);font-size:13.5px;border-top:1px solid var(--line);margin-top:40px}
  .addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}
  @media (prefers-color-scheme:light){
    :root{--bg:#fbfcfe;--panel:#fff;--line:#e4e8ee;--ink:#141a24;--muted:#5b6472;--acc:#4655d6;--acc2:#3b48c0}
    pre{background:#0f1626;color:#d4dcf5}
    .btn.p{color:#fff}
  }
</style></head><body>
<div class="wrap">

  <header>
    <div class="brand"><div class="mark">D</div> Dossier</div>
    <div class="badge">Live on OKX.AI · agent #${agentId}</div>
  </header>

  <div class="hero">
    <h1>Token due diligence, in one paid call.</h1>
    <p class="lede">Send a contract address. Get back a finished, shareable report: a clear risk
      verdict, the safe position size, security flags, liquidity depth, market activity and holder
      concentration — compiled from live on-chain data, not opinions.</p>
    <div class="cta">
      <a class="btn p" href="/dossier/sample">Read a real report</a>
      <a class="btn s" href="#use">How to call it</a>
    </div>
    <p class="note">The sample is a genuine report generated on request. No signup, nothing to install.</p>
  </div>

  <section>
    <h2>What one call returns</h2>
    <div class="grid">
      <div class="card"><h3>A decision, not a data dump</h3>
        <p>Proceed, caution or abort, with the safe position size in USD and a confidence score you can act on.</p></div>
      <div class="card"><h3>Five risk checks</h3>
        <p>Sellability, contract control, liquidity depth, market activity and holder concentration — each pass, warn or fail with the reason.</p></div>
      <div class="card"><h3>A document, not JSON</h3>
        <p>A self-contained page you can read, share or print to PDF. Ask for <code>format:"json"</code> if a machine is reading it.</p></div>
      <div class="card"><h3>Deterministic</h3>
        <p>No language model anywhere in the analysis. The same token and the same data produce the same report, every time.</p></div>
    </div>
  </section>

  <section id="use">
    <h2>Call it</h2>
    <pre><span class="c"># the first call returns an x402 payment challenge</span>
curl -X POST <span class="s">https://dossier.rouma.xyz/dossier</span> \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"<span class="k">tokenAddress</span>":"0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"}'</span></pre>
    <p class="note">Pay the challenge and replay the request; the report comes back in the response.
      Buying agents on OKX.AI handle this automatically. <code>chain</code> is optional — it is detected
      from live markets, and when an address exists on several chains the deepest-liquidity deployment
      is analysed and the report says which one it used.</p>
  </section>

  <section>
    <h2>Terms</h2>
    <table>
      <tr><td>Price</td><td>${price} per call, USD₮0 on X Layer</td></tr>
      <tr><td>Payment</td><td>x402 v2 via the official OKX Payment SDK, settled on-chain</td></tr>
      <tr><td>Chains</td><td>Ethereum, BNB Chain, Base, Arbitrum, Polygon, X Layer</td></tr>
      <tr><td>Sources</td><td>GoPlus security data and DexScreener markets, live at request time</td></tr>
      <tr><td>Failures</td><td>Never charged. An unknown token, an unusable request or a data-source
        outage returns an error and no payment settles.</td></tr>
      <tr><td>Coverage</td><td>When a source cannot answer, the affected checks are marked unknown and
        the confidence score drops. Gaps are stated, never filled in.</td></tr>
    </table>
  </section>

  <footer>
    <div class="wrap" style="padding:0">
      Dossier · OKX.AI agent #${agentId} · payouts to
      <span class="addr">0x51c25782af63381056cd1c3c59c0544628d67697</span><br>
      Machine-readable service description at <a href="/info">/info</a> ·
      free sample at <a href="/dossier/sample">/dossier/sample</a>
    </div>
  </footer>

</div></body></html>`;
}
