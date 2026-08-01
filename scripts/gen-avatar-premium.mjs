// Premium pass.
//
// The earlier rounds were flat white shapes on flat grounds: legible, but no
// craft. What makes the reference read as expensive is material, not shape —
// depth in the ground, a bloom that implies light, a crisp mark with generous
// space around it. So this pass adds the things that were missing:
//
//   - richer multi-stop grounds, plus a radial vignette so the corners fall off
//   - a gradient on the mark itself, so it reads as a lit surface not a sticker
//   - a soft drop shadow under the mark to lift it off the ground
//   - modulated letterforms (thick bowl, thin joins) instead of slab geometry
//   - the mark at roughly 55% of the canvas rather than 75%, so it can breathe
//
// Unchanged constraints: filled paths only (gradient strokes silently vanished
// from the shipped avatar), square corners (OKX asked for none, and the
// marketplace applies its own mask), and every candidate judged at 32px.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const S = 512;

const defs = (a, b, c, glow) => `
  <linearGradient id="bg" x1="0.15" y1="0" x2="0.85" y2="1">
    <stop offset="0" stop-color="${a}"/>
    <stop offset="0.55" stop-color="${b}"/>
    <stop offset="1" stop-color="${c}"/>
  </linearGradient>
  <radialGradient id="vig" cx="0.5" cy="0.42" r="0.78">
    <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000000" stop-opacity="0.45"/>
  </radialGradient>
  <!-- userSpaceOnUse, not the default objectBoundingBox. With per-element boxes a
       narrow stem and a wide bowl receive different ramps, which left a visible
       tonal seam down the letter. Mapping to the canvas makes every part of a
       mark share one light direction. -->
  <linearGradient id="mk" gradientUnits="userSpaceOnUse" x1="140" y1="120" x2="400" y2="390">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="0.62" stop-color="#f2f5fb"/>
    <stop offset="1" stop-color="#c8d2e6"/>
  </linearGradient>
  <linearGradient id="metal" gradientUnits="userSpaceOnUse" x1="120" y1="110" x2="400" y2="400">
    <stop offset="0" stop-color="#ffe9b0"/>
    <stop offset="0.45" stop-color="#e8bf6a"/>
    <stop offset="1" stop-color="#9c6f24"/>
  </linearGradient>
  <filter id="bloom" x="-70%" y="-70%" width="240%" height="240%">
    <feGaussianBlur stdDeviation="54"/>
  </filter>
  <filter id="lift" x="-40%" y="-40%" width="180%" height="180%">
    <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000000" flood-opacity="0.45"/>
  </filter>`;

const scene = (a, b, c, glow, mark) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>${defs(a, b, c, glow)}</defs>
  <rect width="${S}" height="${S}" fill="url(#bg)"/>
  <ellipse cx="256" cy="498" rx="210" ry="112" fill="${glow}" opacity="0.7" filter="url(#bloom)"/>
  <rect width="${S}" height="${S}" fill="url(#vig)"/>
  <g filter="url(#lift)">${mark}</g>
</svg>`;

// A Didone-ish D: heavy bowl on the right, thin at the top and bottom joins, a
// true vertical stem. Curves are cubics rather than arcs so the modulation is
// controllable — this is what separates a letterform from a rounded rectangle.
// One path, not a bowl plus a separate stem rectangle. Two overlapping filled
// elements is what produced the seam; the outer contour simply starts at the
// stem's left edge, and the counter is the second subpath under evenodd.
const monogramD = (fill) => `
  <path fill="${fill}" fill-rule="evenodd" d="
    M152 138 H286 C 368 138, 414 188, 414 255 C 414 322, 368 374, 286 374 H152 Z
    M224 190 H283 C 330 190, 350 214, 350 255 C 350 298, 330 322, 283 322 H224 Z"/>`;

// Refined lens: a thin annulus, generous interior, slim tapered handle. The
// earlier magnifier failed on elegance because the ring was as thick as the
// hole was wide.
const lens = (fill) => `
  <path fill="${fill}" fill-rule="evenodd" d="
    M236 130 a116 116 0 1 1 -0.1 0 Z
    M236 172 a74 74 0 1 0 0.1 0 Z"/>
  <rect x="308" y="330" width="132" height="34" rx="17"
        transform="rotate(45 308 330)" fill="${fill}"/>`;

// A signet: the oldest mark of an authenticated document, and the closest thing
// to "classy" the brief has available. Ring plus embossed monogram.
const signet = `
  <circle cx="256" cy="252" r="150" fill="url(#metal)"/>
  <circle cx="256" cy="252" r="150" fill="none" stroke="#7a5518" stroke-width="6" opacity="0.55"/>
  <circle cx="256" cy="252" r="118" fill="none" stroke="#7a5518" stroke-width="5" opacity="0.4"/>
  <g transform="translate(-6,-8) scale(0.66) translate(140,150)">
    <path fill="#4a3208" fill-rule="evenodd" d="
      M170 140 H286 C 366 140, 412 190, 412 256 C 412 322, 366 372, 286 372 H170 Z
      M226 186 H284 C 330 186, 352 212, 352 256 C 352 300, 330 326, 284 326 H226 Z"/>
    <rect x="150" y="140" width="52" height="232" fill="#4a3208"/>
  </g>`;

const variants = {
  P1: scene("#0a1024", "#132a6b", "#2f57d8", "#6f93ff", monogramD("url(#mk)")),
  P2: scene("#0a1024", "#132a6b", "#2f57d8", "#6f93ff", lens("url(#mk)")),
  P3: scene("#101010", "#2a1c07", "#c9922f", "#ffd98a", monogramD("url(#mk)")),
  P4: scene("#07120f", "#0d3b30", "#1c8f6a", "#63e0b4", monogramD("url(#mk)")),
  P5: scene("#0b0b12", "#1a1a26", "#2b2b3d", "#6f6f9a", signet),
};

mkdirSync("submission/avatars", { recursive: true });
for (const [n, svg] of Object.entries(variants)) {
  const b = Buffer.from(svg);
  await sharp(b).png().toFile(`submission/avatars/${n}.png`);
  for (const px of [64, 48, 32]) {
    await sharp(b).resize(px, px).png().toFile(`submission/avatars/${n}-${px}.png`);
  }
}
console.log("  wrote", Object.keys(variants).join(", "));
