import type { Dossier } from "./report";
import { formatLockedPct } from "../engine/sources/goplus";

// Renders a Dossier as a self-contained HTML document — no external assets, so
// it can be saved, shared, or printed to PDF as-is. This is the "asset" the ASP
// produces: an executive-ready page, not a raw data dump.

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const money = (n?: number): string =>
  n === undefined ? "—" : "$" + Math.round(n).toLocaleString("en-US");

// Token prices span ~$100k to $0.000000001; plain concatenation would emit
// scientific notation ("$1.2e-8") below 1e-6. Always render decimal form.
const price = (n?: number): string =>
  n === undefined || !Number.isFinite(n)
    ? "—"
    : "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 20 });

const pct = (n?: number): string => (n === undefined ? "—" : `${n.toFixed(1)}%`);

// "—" for a lock we could not establish, never "0.0%". The row reads as a
// measurement, and this is the same reason `lockNote` does not round to zero.
const lockPct = (n?: number): string => (n === undefined ? "—" : formatLockedPct(n, 1));

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

export interface RenderOpts {
  // Shown as a slim banner above the report (used by the free sample route).
  banner?: string;
}

export function renderDossierHtml(d: Dossier, opts: RenderOpts = {}): string {
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
  .chainnote { margin-top:8px; padding:8px 10px; border-left:3px solid #b7791f; background:#fdf6e7;
    color:#6b5316; font-size:12.5px; max-width:60ch; }
  .banner { background:#eef1f7; border:1px solid var(--line); border-radius:10px;
    padding:10px 14px; font-size:13px; color:var(--muted); margin-bottom:24px; }
  @media print { body { background:#fff; } .wrap { padding:0; } .banner { display:none; } }
</style></head><body><div class="wrap">
  ${opts.banner ? `<div class="banner">${esc(opts.banner)}</div>` : ""}
  <header>
    <div>
      <h1>${esc(d.title)}</h1>
      <div class="sub">${esc(d.token.chain)} · <span class="addr">${esc(d.token.address)}</span></div>
      ${
        d.chainResolution?.ambiguous
          ? `<div class="chainnote">This address is deployed on more than one chain. This report covers the
             <strong>${esc(d.token.chain)}</strong> deployment, which holds the deepest liquidity. Also deployed on
             ${esc(d.chainResolution.alternatives.join(", "))} — request again with that chain to analyse it instead.</div>`
          : ""
      }
    </div>
    <div class="badge" style="background:${vc}">
      <div class="v">${esc(v.verdict)}</div>
      <div class="c">data coverage ${(v.confidence * 100).toFixed(0)}%</div>
    </div>
  </header>

  <section>
    <h2>Snapshot</h2>
    <div class="grid">
      <div class="cell"><div class="k">Price</div><div class="val">${price(d.token.priceUsd)}</div></div>
      <div class="cell"><div class="k">Liquidity (all pools)</div><div class="val">${money(d.token.liquidityUsd)}</div></div>
      <div class="cell"><div class="k">Deepest pool</div><div class="val">${money(d.token.deepestPoolUsd)}</div></div>
      <div class="cell"><div class="k">24h Volume</div><div class="val">${money(d.token.volume24hUsd)}</div></div>
      <div class="cell"><div class="k">Pair age</div><div class="val">${d.token.ageDays !== undefined ? d.token.ageDays + "d" : "—"}</div></div>
      <div class="cell"><div class="k">Holders</div><div class="val">${d.token.holderCount?.toLocaleString("en-US") ?? "—"}</div></div>
      <div class="cell"><div class="k">Heuristic size cap</div><div class="val">${v.maxSizeUsd !== null ? money(v.maxSizeUsd) : "—"}</div>
        <div class="k" style="margin-top:4px;text-transform:none;letter-spacing:0">1% of the deepest pool, halved on caution. A rule of thumb, not a slippage guarantee.</div></div>
    </div>
  </section>

  <section>
    <h2>Risk checks</h2>
    <table>${rows}</table>
    <div class="k" style="margin-top:8px;text-transform:none;letter-spacing:0">
      Data coverage is the share of these five checks answered by live data, not a probability
      that the token is safe. The risk decision is the verdict above.</div>
  </section>

  <section>
    <h2>Key findings</h2>
    <ul class="reasons">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
  </section>

  ${
    d.contract && d.contract.isContract
      ? `<section>
    <h2>On-chain identity</h2>
    <div class="kv">
      <div><span class="lab">Name</span><span>${esc(d.contract.name ?? "—")}</span></div>
      <div><span class="lab">Symbol</span><span>${esc(d.contract.symbol ?? "—")}</span></div>
      <div><span class="lab">Decimals</span><span>${d.contract.decimals ?? "—"}</span></div>
      <div><span class="lab">Total supply</span><span>${
        d.contract.totalSupply !== undefined
          ? Math.round(d.contract.totalSupply).toLocaleString("en-US")
          : "—"
      }</span></div>
      <div><span class="lab">Owner</span><span class="addr">${
        d.contract.ownerRenounced
          ? "renounced"
          : d.contract.owner
            ? esc(d.contract.owner)
            : "not exposed"
      }</span></div>
      <div><span class="lab">Proxy implementation</span><span class="addr">${
        d.contract.proxyImplementation ? esc(d.contract.proxyImplementation) : "not a proxy"
      }</span></div>
    </div>
    ${
      d.contract.capabilities?.length
        ? `<div class="chainnote">Functions found in the deployed bytecode:
           <strong>${esc(d.contract.capabilities.join(", "))}</strong>. Detected by scanning the
           contract's dispatch table, so treat this as evidence rather than proof.</div>`
        : ""
    }
  </section>`
      : ""
  }

  <section>
    <h2>Contract &amp; distribution</h2>
    <div class="kv">
      <div><span class="lab">Verified source</span><span>${yesno(d.security.openSource)}</span></div>
      <div><span class="lab">Upgradeable proxy</span><span>${yesno(d.security.proxy)}</span></div>
      <div><span class="lab">Mintable</span><span>${yesno(d.security.mintable)}</span></div>
      <div><span class="lab">Owner renounced</span><span>${yesno(d.security.ownerRenounced)}</span></div>
      <div><span class="lab">Buy tax</span><span>${pct(d.security.buyTaxPct)}</span></div>
      <div><span class="lab">Sell tax</span><span>${pct(d.security.sellTaxPct)}</span></div>
      <div><span class="lab">LP locked</span><span>${lockPct(d.security.lpLockedPct)}</span></div>
      <div><span class="lab">Top-10 holders</span><span>${pct(d.security.topHolderPct)}</span></div>
    </div>
  </section>

  ${
    d.attestation
      ? `<section>
    <h2>Verification</h2>
    <div class="kv">
      <div><span class="lab">Report id</span><span class="addr">${esc(d.attestation.payload.reportId)}</span></div>
      <div><span class="lab">Methodology</span><span class="addr">${esc(d.attestation.payload.methodologyVersion)}</span></div>
      <div><span class="lab">Payload sha256</span><span class="addr">${esc(d.attestation.payloadSha256)}</span></div>
      <div><span class="lab">Observed at block</span><span class="addr">${
        d.attestation.payload.blockNumber
          ? `${esc(d.attestation.payload.chainId)} @ ${esc(d.attestation.payload.blockNumber)}`
          : "not recorded"
      }</span></div>
    </div>
    ${
      d.attestation.signature
        ? `<div class="kv" style="margin-top:8px">
        <div><span class="lab">Signature</span><span class="addr">${esc(d.attestation.signature)}</span></div>
        <div><span class="lab">Public key</span><span class="addr">${esc(d.attestation.publicKey)}</span></div>
      </div>
      <div class="chainnote">Check this report yourself at ${esc(d.attestation.verifyWith)}. It runs in
        your browser, against a key you can fetch separately. A valid signature proves who issued the
        report, and that the whole of it is unaltered: every figure, flag and explanation
        printed above is covered, not just the verdict. It does not
        prove the sources were
        right, and it does not cover the payment transaction, which does not exist when the report is
        made.</div>`
        : `<div class="chainnote">${esc(d.attestation.unsignedReason)} The payload hash above can
           still be checked at ${esc(d.attestation.verifyWith)}, which confirms the report has not
           been altered even though nothing attests to who issued it.</div>`
    }
  </section>`
      : ""
  }

  <footer>
    <span>Dossier · OKX.AI agent #7012 · sources: ${d.sources.length ? esc(d.sources.join(", ")) : "none available"}</span>
    <span>Generated ${esc(d.generatedAt)}</span>
  </footer>
</div></body></html>`;
}
