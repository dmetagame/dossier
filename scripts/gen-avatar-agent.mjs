// "An agent doing due diligence" — scrutiny, not output.
//
// Constraints carried over from the earlier rounds, all learned the hard way:
//   - Judge at 32px. A stamp ring and a three-colour band both looked fine at
//     512 and collapsed when downscaled.
//   - Flat fills and plain strokes only. The shipped avatar lost its outline and
//     content lines because they were stroked with a gradient reference.
//   - Keep the ochre. In a row of real neighbours it was the only tile that
//     pulled the eye, because colour resolves before silhouette at this size.
//
// A magnifier is the one shape that reads as "examining" at any size: a thick
// ring plus a stub handle, both pure geometry.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const INK = "#14161c";
const MANILA = "#d9a441";
const PAPER = "#fbfcfe";
const S = 512;

const wrap = (inner, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
     <rect width="${S}" height="${S}" fill="${bg}"/>${inner}</svg>`;

// Magnifier as one path-free group: ring + handle. Handle is drawn first so the
// ring sits on top and the joint stays clean at small sizes.
const glass = (col, lens, cx, cy, r, w) => `
  <line x1="${cx + r * 0.72}" y1="${cy + r * 0.72}" x2="${cx + r * 0.72 + 92}" y2="${cy + r * 0.72 + 92}"
        stroke="${col}" stroke-width="${w + 8}" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${lens}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="${w}"/>`;

// N: document behind, magnifier over it. The literal reading of the brief.
const N = wrap(
  `<path fill="${INK}" d="M104 78 H268 L330 140 V330 H104 Z"/>
   <path fill="${MANILA}" d="M268 78 V140 H330 Z"/>
   ${glass(INK, MANILA, 286, 286, 108, 40)}`,
  MANILA,
);

// O: magnifier alone, lens holding redaction bars. Scrutiny plus dossier, and
// the bars are the only interior detail, so there is nothing else to muddy.
const O = wrap(
  `${glass(INK, MANILA, 236, 232, 150, 46)}
   <g fill="${INK}">
     <rect x="150" y="196" width="172" height="26"/>
     <rect x="150" y="244" width="118" height="26"/>
   </g>`,
  MANILA,
);

// P: magnifier over a token. A coin is the thing being diligenced, and a circle
// inside a circle stays legible where a document silhouette starts to blur.
const P = wrap(
  `<circle cx="228" cy="228" r="128" fill="${INK}"/>
   <circle cx="228" cy="228" r="58" fill="${MANILA}"/>
   ${glass(INK, "none", 300, 300, 128, 44)}`,
  MANILA,
);

// Q: the agent itself. A head silhouette whose eye is the lens: the machine is
// the one doing the looking, which is the part "agent" adds to "due diligence".
const Q = wrap(
  `<rect x="128" y="132" width="256" height="228" rx="28" fill="${INK}"/>
   <rect x="240" y="86" width="32" height="52" fill="${INK}"/>
   <circle cx="256" cy="66" r="26" fill="${INK}"/>
   <circle cx="206" cy="238" r="34" fill="${MANILA}"/>
   <circle cx="318" cy="238" r="54" fill="${MANILA}"/>
   <circle cx="318" cy="238" r="54" fill="none" stroke="${PAPER}" stroke-width="14"/>
   <line x1="356" y1="276" x2="404" y2="324" stroke="${INK}" stroke-width="34" stroke-linecap="round"/>`,
  MANILA,
);

// R: inverted N, ink ground. Included to test whether the dark tile costs as
// much here as it did last round, now that the mark itself is stronger.
const R = wrap(
  `<path fill="${MANILA}" d="M104 78 H268 L330 140 V330 H104 Z"/>
   <path fill="${INK}" d="M268 78 V140 H330 Z"/>
   ${glass(MANILA, INK, 286, 286, 108, 40)}`,
  INK,
);

mkdirSync("submission/avatars", { recursive: true });
for (const [n, svg] of Object.entries({ N, O, P, Q, R })) {
  const b = Buffer.from(svg);
  await sharp(b).png().toFile(`submission/avatars/${n}.png`);
  for (const px of [64, 48, 32]) {
    await sharp(b).resize(px, px).png().toFile(`submission/avatars/${n}-${px}.png`);
  }
}
console.log("  wrote N, O, P, Q, R");
