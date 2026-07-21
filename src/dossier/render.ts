import type { Dossier } from "./report";

// Renders a Dossier as a self-contained HTML document — no external assets, so
// it can be saved, shared, or printed to PDF as-is. This is the "asset" the ASP
// produces: an executive-ready page, not a raw data dump.

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const money = (n?: number): string =>
  n === undefined ? "—" : "$" + Math.round(n).toLocaleString("en-US");

const pct = (n?: number): string => (n === undefined ? "—" : `${n.toFixed(1)}%`);

const yesno = (b?: boolean): string => (b === undefined ? "—" : b ? "Yes" : "No");

const VERDICT_COLOR: Record<string, string> = {
  proceed: "#1c8f5a",
  caution: "#b7791f",
  abort: "#c02b2b",
};

function checkRow(label: string, status: string, detail: string): string {
  const dot = { pass: "#1c8f5a", warn: "#b7791f", fail: "#c02b2b", unknown: "#8a94a6" }[status] ?? "#8a94a6";
  return `<tr><td class="chk"><span class="dot" style="background:${dot}"></span>${esc(label)}</td>
    <td class="st">${esc(status)}</td><td>${esc(detail)}</td></tr>`;
}

export function renderDossierHtml(d: Dossier): string {
  const v = d.riskVerdict;
  const vc = VERDICT_COLOR[v.verdict] ?? "#8a94a6";
  const checks = v.checks;
  const rows = [
    checkRow("Sellability", checks.honeypot.status, checks.honeypot.detail),
    checkRow("Contract control", checks.contractControl.status, checks.contractControl.detail),
    checkRow("Liquidity", checks.liquidity.status, checks.liquidity.detail),
    checkRow("Market activity", checks.marketActivity.status, checks.marketActivity.detail),
    checkRow("Holder concentration", checks.holderConcentration.status, checks.holderConcentration.detail),
  ].join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)}</title>
<style>
  :root { --ink:#141a24; --muted:#5b6472; --line:#e4e8ee; --bg:#fbfcfe; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 40px 28px 64px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px;
    border-bottom:2px solid var(--ink); padding-bottom:16px; }
  h1 { font-size:22px; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:13px; margin-top:4px; }
  .badge { flex:none; text-align:center; color:#fff; border-radius:10px; padding:12px 18px; }
  .badge .v { font-size:20px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
  .badge .c { font-size:11px; opacity:.9; margin-top:2px; }
  section { margin-top:28px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
    margin:0 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .cell { border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:#fff; }
  .cell .k { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .cell .val { font-size:18px; font-weight:600; margin-top:3px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line);
    border-radius:10px; overflow:hidden; }
  td { padding:10px 14px; border-top:1px solid var(--line); vertical-align:top; font-size:14px; }
  tr:first-child td { border-top:none; }
  .chk { font-weight:600; white-space:nowrap; }
  .st { text-transform:capitalize; color:var(--muted); width:78px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:8px; }
  ul.reasons { margin:0; padding-left:18px; } ul.reasons li { margin:4px 0; }
  .kv { display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; }
  .kv div { display:flex; justify-content:space-between; border-bottom:1px dotted var(--line); padding:5px 0; }
  .kv .lab { color:var(--muted); }
  footer { margin-top:36px; padding-top:14px; border-top:1px solid var(--line);
    color:var(--muted); font-size:12px; display:flex; justify-content:space-between; }
  .addr { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; word-break:break-all; }
  @media print { body { background:#fff; } .wrap { padding:0; } }
</style></head><body><div class="wrap">
  <header>
    <div>
      <h1>${esc(d.title)}</h1>
      <div class="sub">${esc(d.token.chain)} · <span class="addr">${esc(d.token.address)}</span></div>
    </div>
    <div class="badge" style="background:${vc}">
      <div class="v">${esc(v.verdict)}</div>
      <div class="c">confidence ${(v.confidence * 100).toFixed(0)}%</div>
    </div>
  </header>

  <section>
    <h2>Snapshot</h2>
    <div class="grid">
      <div class="cell"><div class="k">Price</div><div class="val">${d.token.priceUsd !== undefined ? "$" + d.token.priceUsd : "—"}</div></div>
      <div class="cell"><div class="k">Liquidity</div><div class="val">${money(d.token.liquidityUsd)}</div></div>
      <div class="cell"><div class="k">24h Volume</div><div class="val">${money(d.token.volume24hUsd)}</div></div>
      <div class="cell"><div class="k">Pair age</div><div class="val">${d.token.ageDays !== undefined ? d.token.ageDays + "d" : "—"}</div></div>
      <div class="cell"><div class="k">Holders</div><div class="val">${d.token.holderCount?.toLocaleString("en-US") ?? "—"}</div></div>
      <div class="cell"><div class="k">Safe max size</div><div class="val">${v.maxSizeUsd !== null ? money(v.maxSizeUsd) : "—"}</div></div>
    </div>
  </section>

  <section>
    <h2>Risk checks</h2>
    <table>${rows}</table>
  </section>

  <section>
    <h2>Key findings</h2>
    <ul class="reasons">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
  </section>

  <section>
    <h2>Contract &amp; distribution</h2>
    <div class="kv">
      <div><span class="lab">Verified source</span><span>${yesno(d.security.openSource)}</span></div>
      <div><span class="lab">Upgradeable proxy</span><span>${yesno(d.security.proxy)}</span></div>
      <div><span class="lab">Mintable</span><span>${yesno(d.security.mintable)}</span></div>
      <div><span class="lab">Owner renounced</span><span>${yesno(d.security.ownerRenounced)}</span></div>
      <div><span class="lab">Buy tax</span><span>${pct(d.security.buyTaxPct)}</span></div>
      <div><span class="lab">Sell tax</span><span>${pct(d.security.sellTaxPct)}</span></div>
      <div><span class="lab">LP locked</span><span>${pct(d.security.lpLockedPct)}</span></div>
      <div><span class="lab">Top-10 holders</span><span>${pct(d.security.topHolderPct)}</span></div>
    </div>
  </section>

  <footer>
    <span>Sources: ${d.sources.length ? esc(d.sources.join(", ")) : "none available"}</span>
    <span>Generated ${esc(d.generatedAt)}</span>
  </footer>
</div></body></html>`;
}
