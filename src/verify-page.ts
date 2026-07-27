// The public verifier.
//
// It checks reports **in the visitor's browser**, using WebCrypto, against a
// key they can fetch separately. That matters: a verifier that asks our server
// whether our own signature is valid is not a verifier, it is a second copy of
// the claim. Nothing here is posted anywhere, and the page works with no wallet
// and no account.
//
// The same check is twelve lines of Node, printed on the page, for anyone who
// would rather not trust a web page either.

import { FONT_FACE_CSS, FONTS } from "./fonts";

const SCRIPT = String.raw`
const $ = (s) => document.querySelector(s);
const out = $("#out");

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const e = Object.entries(v).filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + e.map(([k, x]) => JSON.stringify(k) + ":" + canonical(x)).join(",") + "}";
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function line(ok, text) {
  return '<div class="r ' + (ok === true ? "ok" : ok === false ? "no" : "na") + '">' +
    (ok === true ? "PASS" : ok === false ? "FAIL" : "  · ") + "  " + text + "</div>";
}

async function run() {
  out.innerHTML = "";
  let att;
  try {
    att = JSON.parse($("#input").value);
  } catch (e) {
    out.innerHTML = line(false, "That is not valid JSON.");
    return;
  }
  if (att.attestation) att = att.attestation;
  if (!att || !att.payload) {
    out.innerHTML = line(false, "No attestation found. Paste the report's attestation object, or the whole JSON report.");
    return;
  }

  const canonicalBytes = new TextEncoder().encode(canonical(att.payload));
  const digest = hex(await crypto.subtle.digest("SHA-256", canonicalBytes));
  const hashOk = digest === att.payloadSha256;

  let html = line(hashOk, hashOk
    ? "The payload hashes to the value in the attestation."
    : "The payload does NOT hash to the stated value: it has been altered.");
  html += '<div class="mono small">recomputed ' + digest + "</div>";

  const pinned = $("#key").value.trim();
  const key = pinned || att.publicKey;
  if (!att.signature) {
    html += line(null, "This report carries no signature, only a hash.");
  } else if (!key) {
    html += line(null, "No public key to check against. Fetch one from /.well-known/dossier-signing-key.json.");
  } else if (pinned && att.publicKey && pinned !== att.publicKey) {
    html += line(false, "Signed by a different key than the one you pinned.");
  } else {
    try {
      const pub = await crypto.subtle.importKey("jwk",
        { kty: "OKP", crv: "Ed25519", x: key }, { name: "Ed25519" }, false, ["verify"]);
      const sigOk = await crypto.subtle.verify("Ed25519", pub, b64u(att.signature), canonicalBytes);
      html += line(sigOk, sigOk
        ? "The signature is valid for this payload and key."
        : "The signature is NOT valid for this payload and key.");
    } catch (e) {
      html += line(null, "This browser could not run Ed25519 (" + e.message + "). Use the Node snippet below.");
    }
  }

  const p = att.payload;
  html += '<div class="facts">'
    + row("Report", p.reportId)
    + row("Token", (p.token && p.token.address) + " on " + (p.token && p.token.chain))
    + row("Verdict", p.result && p.result.verdict)
    + row("Coverage", p.result && (p.result.coverage * 100) + "%")
    + row("Issued", p.issuedAt)
    + row("Issuer", p.issuer && ("agent #" + p.issuer.agentId))
    + row("Block", p.blockNumber ? (p.chainId + " @ " + p.blockNumber) : "not recorded")
    + row("Methodology", p.methodologyVersion)
    + "</div>";
  if (p.observations && p.observations.length) {
    html += '<div class="facts"><div class="h">Sources, as read at issue time</div>'
      + p.observations.map((o) => row(o.source, o.status
        + (o.retrievedAt ? " · " + o.retrievedAt : "")
        + (o.responseSha256 ? " · sha256 " + o.responseSha256.slice(0, 16) + "…" : ""))).join("")
      + "</div>";
  }
  out.innerHTML = html;
}
function row(k, v) {
  return '<div class="f"><span>' + k + "</span><span class=\"mono\">" + (v == null ? "—" : String(v)) + "</span></div>";
}
$("#go").addEventListener("click", run);
$("#fetchkey").addEventListener("click", async () => {
  const r = await fetch("/.well-known/dossier-signing-key.json");
  const j = await r.json();
  $("#key").value = j.publicKey || "";
});
`;

export function renderVerifyHtml(origin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify a Dossier report</title>
<meta name="description" content="Check that a Dossier due-diligence report is authentic and unaltered. Runs entirely in your browser, no wallet, no account.">
<link rel="preload" href="${FONTS.serif!.path}" as="font" type="font/woff2" crossorigin>
<style>
${FONT_FACE_CSS}
:root{--ink:#141a24;--muted:#5b6472;--line:#e4e8ee;--bg:#fbfcfe;--paper:#fff;
  --ok:#1c8f5a;--no:#c02b2b;--na:#8a94a6;
  --serif:"Instrument Serif",Georgia,serif;
  --sans:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:1rem/1.6 var(--sans)}
.wrap{max-width:860px;margin:0 auto;padding:0 28px 5rem}
header{padding:1.75rem 0;display:flex;justify-content:space-between;align-items:center}
.brand{font:600 1.0625rem/1 var(--sans);letter-spacing:-.02em}
a{color:var(--ink)}
h1{font:400 clamp(2.25rem,5vw,3.5rem)/1 var(--serif);letter-spacing:-.03em;margin:1.5rem 0 0}
.lede{color:var(--muted);max-width:60ch;margin:1rem 0 2rem}
label{display:block;font:600 .75rem/1 var(--mono);text-transform:uppercase;
  letter-spacing:.12em;color:var(--muted);margin:1.5rem 0 .5rem}
textarea,input{width:100%;font:.8125rem/1.6 var(--mono);color:var(--ink);background:var(--paper);
  border:1px solid var(--line);border-radius:8px;padding:.85rem}
textarea{min-height:190px;resize:vertical}
.row{display:flex;gap:.5rem;align-items:center}
button{font:500 .9375rem/1.2 var(--sans);padding:.7rem 1.15rem;border-radius:7px;
  border:1px solid var(--ink);background:var(--ink);color:var(--bg);cursor:pointer}
button.s{background:transparent;color:var(--ink);border-color:var(--line)}
button:focus-visible,a:focus-visible,textarea:focus-visible,input:focus-visible{
  outline:2px solid var(--ink);outline-offset:2px}
#out{margin-top:1.75rem}
.r{font:.9375rem/1.5 var(--mono);padding:.6rem .8rem;border-radius:7px;margin-bottom:.4rem;
  border:1px solid var(--line);background:var(--paper)}
.r.ok{color:var(--ok);border-color:rgba(28,143,90,.35)}
.r.no{color:var(--no);border-color:rgba(192,43,43,.35)}
.r.na{color:var(--na)}
.small{font-size:.75rem;color:var(--muted);word-break:break-all;margin:.1rem 0 .8rem}
.mono{font-family:var(--mono)}
.facts{border:1px solid var(--line);border-radius:8px;background:var(--paper);
  padding:.5rem .9rem;margin-top:1rem}
.facts .h{font:600 .75rem/2.2 var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.f{display:flex;justify-content:space-between;gap:1.5rem;padding:.45rem 0;
  border-top:1px dotted var(--line);font-size:.8125rem}
.f:first-child{border-top:none}
.f span:first-child{color:var(--muted)}
.f span:last-child{word-break:break-all;text-align:right}
pre{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:1rem;
  overflow-x:auto;font:.75rem/1.7 var(--mono)}
section{border-top:1px solid var(--line);margin-top:3rem;padding-top:2rem}
h2{font:400 1.5rem/1.2 var(--serif);margin:0 0 .75rem}
p{color:var(--muted)}
</style></head><body><div class="wrap">
<header><div class="brand">Dossier</div><a href="/">Home</a></header>

<h1>Verify a report</h1>
<p class="lede">Paste a report's attestation, or the whole JSON report. The check runs entirely in
this page: the payload is re-hashed and the signature verified against a public key you can fetch
yourself. Nothing is uploaded, and you need no wallet and no account.</p>

<label for="input">Attestation or JSON report</label>
<textarea id="input" spellcheck="false" placeholder='{"payload":{…},"payloadSha256":"…","signature":"…"}'></textarea>

<label for="key">Public key to check against <span style="text-transform:none;letter-spacing:0">(optional; pin it yourself rather than trusting the one inside the report)</span></label>
<div class="row">
  <input id="key" spellcheck="false" placeholder="base64url Ed25519 public key">
  <button class="s" id="fetchkey" type="button">Fetch published key</button>
</div>

<div class="row" style="margin-top:1.25rem"><button id="go" type="button">Verify</button></div>
<div id="out"></div>

<section>
  <h2>Or verify it yourself</h2>
  <p>If you would rather not trust this page either, the same check in Node:</p>
<pre>const { createPublicKey, createHash, verify } = require("node:crypto");
const att = require("./report-attestation.json");          // or report.attestation

const canonical = (v) =&gt; v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
  : "{" + Object.entries(v).filter(([,x]) =&gt; x !== undefined)
      .sort(([a],[b]) =&gt; a &lt; b ? -1 : 1)
      .map(([k,x]) =&gt; JSON.stringify(k) + ":" + canonical(x)).join(",") + "}";

const bytes = Buffer.from(canonical(att.payload), "utf8");
const key = createPublicKey({ key: { kty:"OKP", crv:"Ed25519", x: PINNED_KEY }, format:"jwk" });

console.log("hash  ", createHash("sha256").update(bytes).digest("hex") === att.payloadSha256);
console.log("signed", verify(null, bytes, key, Buffer.from(att.signature, "base64url")));</pre>
  <p>The published key lives at
  <a href="/.well-known/dossier-signing-key.json">/.well-known/dossier-signing-key.json</a>.</p>
</section>

<section>
  <h2>What a valid signature does and does not prove</h2>
  <p><strong>It proves</strong> the report was issued by the holder of that key, that its findings
  and its inputs have not been altered since, and which sources were read, when, and what they
  returned, down to the hash of each response.</p>
  <p><strong>It does not prove</strong> that the sources told the truth, nor that a payment was
  made. The settlement transaction is deliberately outside the signature: a report is produced
  before its payment settles, which is what guarantees a failed request cannot charge you, so no
  signature made at issue time could commit to a transaction that does not exist yet. Recovery
  returns the transaction next to the attestation, and it is our word, not the key's.</p>
</section>

</div><script>${SCRIPT.replace(/<\//g, "<\\/")}</script></body></html>`;
}
