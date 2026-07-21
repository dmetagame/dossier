import { buildDossier } from "../src/dossier/report";
import { renderDossierHtml } from "../src/dossier/render";
import { writeFileSync } from "node:fs";

async function main() {
  const d = await buildDossier({ chain: "bsc", tokenAddress: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", format: "html" });
  console.log("title:", d.title);
  console.log("verdict:", d.riskVerdict.verdict, "conf", d.riskVerdict.confidence, "maxSize", d.riskVerdict.maxSizeUsd);
  console.log("snapshot:", { price: d.token.priceUsd, liq: d.token.liquidityUsd, vol: d.token.volume24hUsd, holders: d.token.holderCount });
  console.log("sources:", d.sources.join(", "));
  const html = renderDossierHtml(d);
  const out = "/tmp/claude-1000/-home-rouma/6c72fc92-be6a-485b-bd7d-341c8cace7e3/scratchpad/dossier-sample.html";
  writeFileSync(out, html);
  console.log("html bytes:", html.length, "->", out);
}
main();
