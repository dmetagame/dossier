// Bolder avatar directions for agent 7012.
//
// The first round failed on ambition, not execution: five variants of a generic
// document icon. A document says "docs"; it does not say Dossier, and it cannot
// compete in a list against a lime storefront or a face.
//
// The concept here is what the word actually means: a confidential file. Manila
// and redaction bars. Two reasons that works where the last round did not:
//   - No other agent avatar in the sampled row is ochre. Colour is the thing the
//     eye resolves first at 32px, well before any silhouette.
//   - Redaction bars are legible at any size, because they are just high
//     contrast rectangles, and they read as "file" rather than "page".
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const INK = "#14161c";
const MANILA = "#d9a441";
const MANILA_LT = "#e8c170";
const PAPER = "#fbfcfe";
const INDIGO = "#4f5bd5";
const S = 512;

const wrap = (inner, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
     <rect width="${S}" height="${S}" fill="${bg}"/>${inner}</svg>`;

// A heavy D, drawn as geometry rather than text: no font to resolve, so it
// rasterises identically everywhere.
const bigD = (fill) => `
  <path fill="${fill}" fill-rule="evenodd" d="
    M126 92 H286 C 386 92, 436 164, 436 256 C 436 348, 386 420, 286 420 H126 Z
    M206 168 H286 C 336 168, 356 206, 356 256 C 356 306, 336 344, 286 344 H206 Z"/>`;

// H: manila ground, ink redaction bars. The classified-file read, nothing else.
const H = wrap(
  `<g fill="${INK}">
     <rect x="104" y="150" width="304" height="46"/>
     <rect x="104" y="233" width="212" height="46"/>
     <rect x="104" y="316" width="266" height="46"/>
   </g>`,
  MANILA,
);

// I: manila ground, heavy ink D. A letterform is the most reliable mark at 32px.
const I = wrap(bigD(INK), MANILA);

// J: folder with a tab, ink ground. The tab is the silhouette cue that separates
// a folder from a plain page, and it survives downscaling because it changes the
// outline rather than adding detail inside it.
const J = wrap(
  `<path fill="${MANILA}" d="M92 156 H236 L268 196 H420 V420 H92 Z"/>
   <g fill="${INK}">
     <rect x="132" y="250" width="220" height="34"/>
     <rect x="132" y="312" width="150" height="34"/>
   </g>`,
  INK,
);

// K: manila folder tab on ink, with a single indigo bar kept from the brand.
const K = wrap(
  `<path fill="${MANILA}" d="M92 156 H236 L268 196 H420 V420 H92 Z"/>
   <g fill="${INK}">
     <rect x="132" y="250" width="220" height="34"/>
   </g>
   <rect x="132" y="312" width="150" height="34" fill="${INDIGO}"/>`,
  INK,
);

// L: maximum contrast letterform, paper D on saturated indigo.
const L = wrap(bigD(PAPER), INDIGO);

// M: manila ground, ink D, plus a redaction bar across it. Letterform plus the
// concept, if the D alone reads as generic.
const M = wrap(
  `${bigD(INK)}<rect x="150" y="236" width="250" height="44" fill="${MANILA_LT}"/>`,
  MANILA,
);

mkdirSync("submission/avatars", { recursive: true });
for (const [n, svg] of Object.entries({ H, I, J, K, L, M })) {
  const b = Buffer.from(svg);
  await sharp(b).png().toFile(`submission/avatars/${n}.png`);
  for (const px of [64, 48, 32]) {
    await sharp(b).resize(px, px).png().toFile(`submission/avatars/${n}-${px}.png`);
  }
}
console.log("  wrote H, I, J, K, L, M");
