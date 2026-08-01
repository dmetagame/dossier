// Avatar candidates for agent 7012.
//
// The live avatar failed for one reason: dark navy artwork on a near-identical
// dark navy ground. Marketplace lists render avatars around 32-48px, where low
// contrast collapses into a blob. So every candidate here is checked at 32px,
// not at 512, and the contact sheet renders each at all three sizes.
//
// Two deliberate choices:
//   - A light ground. Crypto agent avatars are overwhelmingly dark, so paper
//     white stands out in a list on the shelf next to them, and it matches the
//     landing page, which is a light document surface.
//   - Flat fills, no gradient strokes. The previous mark used `stroke="url(#acc)"`
//     and the strokes largely did not survive rasterisation, which is how a page
//     outline and three content lines vanished from the shipped PNG.
//
// Square corners on purpose: OKX review asked for no rounded corners and the
// marketplace applies its own mask, so `rx` would bake transparent corners in.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const INK = "#141a24";
const PAPER = "#fbfcfe";
const GREEN = "#1c8f5a";
const AMBER = "#b7791f";
const RED = "#c02b2b";

const S = 512;
const wrap = (inner, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
     <rect width="${S}" height="${S}" fill="${bg}"/>${inner}</svg>`;

// A: solid document silhouette with a cut corner, and a verdict band.
// The band is the one thing this service actually sells: a decision.
const A = wrap(
  `<path d="M150 108 H322 L392 178 V404 H150 Z" fill="${INK}"/>
   <path d="M322 108 V178 H392 Z" fill="${PAPER}"/>
   <rect x="196" y="330" width="150" height="34" fill="${GREEN}"/>`,
  PAPER,
);

// B: the same silhouette, but the band is a three-state scale, which reads as
// "this thing grades something" rather than "this thing is fine".
const B = wrap(
  `<path d="M150 108 H322 L392 178 V404 H150 Z" fill="${INK}"/>
   <path d="M322 108 V178 H392 Z" fill="${PAPER}"/>
   <rect x="190" y="326" width="54" height="38" fill="${GREEN}"/>
   <rect x="244" y="326" width="54" height="38" fill="${AMBER}"/>
   <rect x="298" y="326" width="54" height="38" fill="${RED}"/>`,
  PAPER,
);

// C: inverted. Ink ground, paper document. Keeps the dark look the current one
// was reaching for, but with real contrast between mark and ground.
const C = wrap(
  `<path d="M150 108 H322 L392 178 V404 H150 Z" fill="${PAPER}"/>
   <path d="M322 108 V178 H392 Z" fill="${INK}"/>
   <rect x="190" y="326" width="54" height="38" fill="${GREEN}"/>
   <rect x="244" y="326" width="54" height="38" fill="${AMBER}"/>
   <rect x="298" y="326" width="54" height="38" fill="${RED}"/>`,
  INK,
);

// D: a stamp. Dossier's differentiator is that every report is signed, and a
// seal is the oldest possible shorthand for that. Simplest silhouette of the
// four, so it should survive 32px best.
const D = wrap(
  `<circle cx="256" cy="256" r="150" fill="none" stroke="${INK}" stroke-width="34"/>
   <path d="M206 176 H286 L322 212 V336 H206 Z" fill="${INK}"/>
   <path d="M286 176 V212 H322 Z" fill="${PAPER}"/>`,
  PAPER,
);

const candidates = { A, B, C, D };
mkdirSync("submission/avatars", { recursive: true });

const sheet = [];
for (const [name, svg] of Object.entries(candidates)) {
  const buf = Buffer.from(svg);
  await sharp(buf).png().toFile(`submission/avatars/${name}.png`);
  // Downscale hard: this is the size that decides whether a mark works.
  for (const px of [64, 32]) {
    await sharp(buf).resize(px, px).png().toFile(`submission/avatars/${name}-${px}.png`);
  }
  sheet.push(name);
}
console.log("wrote", sheet.map((n) => `submission/avatars/${n}.png`).join(", "));
