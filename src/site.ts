// Public landing page for dossier.rouma.xyz. Self-contained (no external
// assets or fonts) so it renders instantly and cannot break from a third-party
// outage — the same constraint the report itself is built under.
//
// Template-literal safety: the page below is a TS template literal, so the hero
// blocks are kept in their own constants that contain no backtick and no `${`.
// The inline script therefore uses string concatenation rather than template
// literals. Interpolating the constants is the only substitution that happens.

// Verdict and status colours are taken verbatim from src/dossier/render.ts so
// the hero and the report it advertises cannot drift apart.
const HERO_CSS = `
  .hero-fig{position:relative;margin:26px 0 6px;padding:20px 16px 22px;border:1px solid var(--line);
    border-radius:14px;background:var(--panel);overflow:hidden}
  .hero-fig canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .hf-addr{position:relative;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:13px;color:var(--muted);letter-spacing:.02em;opacity:0;margin-bottom:18px}
  .hf-rows{position:relative;max-width:420px;margin:0 auto}
  .hf-row{display:flex;align-items:center;gap:10px;padding:7px 0;opacity:0;
    transform:translateY(4px);font-size:14px}
  .hf-lbl{flex:1;color:var(--ink)}
  .hf-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--h-idle);transform:scale(.6)}
  .hf-st{width:92px;text-align:right;color:var(--muted);font-size:12.5px;font-variant:small-caps}
  .hf-foot{position:relative;text-align:center;margin-top:20px;min-height:58px}
  .hf-verdict{font-size:20px;font-weight:700;letter-spacing:.06em;opacity:0}
  .hf-meta{font-size:12.5px;color:var(--muted);margin-top:4px;opacity:0}
  @media (max-width:640px){
    .hf-row{font-size:13.5px}
    .hf-st{width:78px}
    .hf-rows{max-width:100%}
  }
`;

const HERO_HTML = `
    <figure class="hero-fig" id="hf" aria-label="A due-diligence report assembling: five checks resolve, one source is unavailable, and the verdict is caution at 80 percent confidence.">
      <canvas id="hfc" aria-hidden="true"></canvas>
      <div class="hf-addr" id="hfa">0x0e09…1cE82</div>
      <div class="hf-rows" id="hfr">
        <div class="hf-row"><span class="hf-lbl">Sellability</span><span class="hf-dot"></span><span class="hf-st"></span></div>
        <div class="hf-row"><span class="hf-lbl">Contract control</span><span class="hf-dot"></span><span class="hf-st"></span></div>
        <div class="hf-row"><span class="hf-lbl">Liquidity</span><span class="hf-dot"></span><span class="hf-st"></span></div>
        <div class="hf-row"><span class="hf-lbl">Market activity</span><span class="hf-dot"></span><span class="hf-st"></span></div>
        <div class="hf-row"><span class="hf-lbl">Holder concentration</span><span class="hf-dot"></span><span class="hf-st"></span></div>
      </div>
      <div class="hf-foot">
        <div class="hf-verdict" id="hfv">CAUTION</div>
        <div class="hf-meta" id="hfm">confidence 80% · safe max size $81,151</div>
      </div>
    </figure>`;

// One 16s loop, time-driven from performance.now() so it is stateless and
// resyncs correctly after being paused. Motion is deterministic by design:
// hard attack, hard stop, snapped positions — an instrument taking a reading,
// which is the same claim the engine makes about itself.
const HERO_JS = `
(function(){
  var fig=document.getElementById('hf'),cv=document.getElementById('hfc');
  if(!fig||!cv||!cv.getContext)return;
  var ctx=cv.getContext('2d'),addr=document.getElementById('hfa'),
      verdict=document.getElementById('hfv'),meta=document.getElementById('hfm'),
      rows=[].slice.call(document.querySelectorAll('.hf-row'));
  var PASS='#1c8f5a',WARN='#b7791f',UNK='#8a94a6',PROBE='#7c8cf8',RULE='#243154';
  var RES=[['pass',PASS],['warn',WARN],['pass',PASS],['pass',PASS],['unavailable',UNK]];
  var LOOP=16000,CONF=0.8,W=0,H=0,dpr=1,anchor=null,dots=[],raf=0,vis=true,seen=true;
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function ease(x){return x<=0?0:x>=1?1:1-Math.pow(2,-10*x);}
  function seg(t,a,b){return (t-a)/(b-a);}
  function measure(){
    var fr=fig.getBoundingClientRect();
    W=fr.width;H=fr.height;
    dpr=Math.min(window.devicePixelRatio||1,2);
    cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    var ar=addr.getBoundingClientRect();
    anchor={x:ar.left-fr.left+ar.width/2,y:ar.top-fr.top+ar.height};
    dots=rows.map(function(r){
      var d=r.querySelector('.hf-dot').getBoundingClientRect();
      return {x:d.left-fr.left+d.width/2,y:d.top-fr.top+d.height/2};
    });
  }
  function draw(t){
    ctx.clearRect(0,0,W,H);
    if(!anchor||!dots.length)return;
    var out=ease(seg(t,15000,15700));
    // Probes are visible only while travelling. Leaving a permanent fan of
    // lines behind was decoration: once a row has resolved, the row itself is
    // the record, and the fan only competed with it during the hold.
    for(var i=0;i<5;i++){
      var go=2000+i*400,land=go+900,p=ease(seg(t,go,land));
      if(t<go||p>=1)continue;
      var d=dots[i],x=anchor.x+(d.x-anchor.x)*p,y=anchor.y+(d.y-anchor.y)*p,
          q=Math.max(0,p-0.12);
      ctx.strokeStyle=PROBE;ctx.globalAlpha=0.85;ctx.lineWidth=1.5;
      ctx.beginPath();
      ctx.moveTo(anchor.x+(d.x-anchor.x)*q,anchor.y+(d.y-anchor.y)*q);
      ctx.lineTo(x,y);ctx.stroke();
    }
    // The arc must retract with everything else or the last frame of the loop
    // would not match the first, and the restart would show a cut.
    var ap=ease(seg(t,10000,11200))*(1-out);
    if(ap>0.001){
      var vr=verdict.getBoundingClientRect(),fr2=fig.getBoundingClientRect();
      var cx=vr.left-fr2.left+vr.width/2,cy=vr.top-fr2.top+vr.height/2,r=Math.max(vr.width,60)/2+16;
      ctx.globalAlpha=ap;
      ctx.strokeStyle=RULE;ctx.lineWidth=2;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();
      ctx.strokeStyle=WARN;ctx.lineWidth=2.5;ctx.lineCap='butt';
      ctx.beginPath();ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+Math.PI*2*CONF*ap);ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
  function apply(t){
    addr.style.opacity=t<15000?String(ease(seg(t,0,400))):String(1-ease(seg(t,15000,15700)));
    for(var i=0;i<5;i++){
      var land=2900+i*400,rp=ease(seg(t,land-200,land+200)),out=ease(seg(t,15000,15700));
      var el=rows[i],dot=el.querySelector('.hf-dot'),st=el.querySelector('.hf-st');
      el.style.opacity=String(rp*(1-out));
      el.style.transform='translateY('+((1-rp)*4)+'px)';
      var rt=6000+i*700,on=t>=rt&&t<15400;
      dot.style.background=on?RES[i][1]:'var(--h-idle)';
      dot.style.transform='scale('+(on?1:0.6)+')';
      st.textContent=on?RES[i][0]:'';
      st.style.color=on?RES[i][1]:'var(--muted)';
    }
    var vp=t>=11200&&t<15400?1:0,vo=ease(seg(t,15000,15700));
    verdict.style.opacity=String(vp*(1-vo));
    verdict.style.color=WARN;
    meta.style.opacity=String((t>=11500&&t<15400?1:0)*(1-vo));
  }
  function frame(){
    var t=reduce?13000:(performance.now()%LOOP);
    apply(t);draw(t);
    if(!reduce&&vis&&seen)raf=requestAnimationFrame(frame);else raf=0;
  }
  function start(){if(!raf&&vis&&seen&&!reduce)raf=requestAnimationFrame(frame);}
  function stop(){if(raf)cancelAnimationFrame(raf);raf=0;}
  measure();
  if(reduce){apply(13000);draw(13000);}
  else{
    document.addEventListener('visibilitychange',function(){vis=!document.hidden;vis?start():stop();});
    if(window.IntersectionObserver){
      new IntersectionObserver(function(e){seen=e[0].isIntersecting;seen?start():stop();},{threshold:0.05}).observe(fig);
    }
    start();
  }
  var rt;
  addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){measure();if(reduce){apply(13000);draw(13000);}},150);});
})();`;


export function renderSiteHtml(opts: { price: string; agentId: number }): string {
  const { price, agentId } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dossier — token due diligence, one paid call</title>
<meta name="description" content="One call returns a finished due-diligence report on any token: risk verdict, safe position size, security flags, liquidity, market activity and holder concentration. Paid per call over x402 on X Layer.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230B1220'/%3E%3Cpath d='M20 14h18l8 8v28H20z' fill='none' stroke='%237C8CF8' stroke-width='4'/%3E%3C/svg%3E">
<style>
  :root{--bg:#0b1220;--panel:#121a2e;--line:#243154;--ink:#eaf0ff;--muted:#9aa8c7;
        --acc:#7c8cf8;--acc2:#5563e6;--ok:#3ecf8e;--warn:#f0b354;
        --h-idle:#2a3352;--h-unknown:#8a94a6;}
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
${HERO_CSS}
  @media (prefers-color-scheme:light){
    :root{--bg:#fbfcfe;--panel:#fff;--line:#e4e8ee;--ink:#141a24;--muted:#5b6472;--acc:#4655d6;--acc2:#3b48c0}
    pre{background:#0f1626;color:#d4dcf5}
    .btn.p{color:#fff}
    :root{--h-idle:#d7dce6}
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
${HERO_HTML}

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

</div>
<script>${HERO_JS}</script>
</body></html>`;
}
