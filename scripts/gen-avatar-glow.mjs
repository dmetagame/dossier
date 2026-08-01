// Avatar in the reference style: near-black at the top, saturated glow at the
// bottom, soft bloom, bold white geometric mark.
//
// One deliberate departure from the reference. It shows a squircle floating on a
// black canvas; here the gradient fills the whole 512 square instead. OKX review
// asked for no rounded corners and the marketplace applies its own mask, so
// baking a squircle in would leave transparent corners inside their rounding.
//
// Gradient *fills* are safe: the current avatar's background gradient rasterised
// correctly. It was the gradient *strokes* that vanished, which is why every
// mark below is a filled path with no stroked geometry.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const S = 512;
const WHITE = "#ffffff";

const scene = (stops, glow, mark) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>
    <filter id="bloom" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="46"/>
    </filter>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#g)"/>
  <ellipse cx="256" cy="486" rx="196" ry="104" fill="${glow}" opacity="0.75" filter="url(#bloom)"/>
  ${mark}
</svg>`;

const BLUE = `<stop offset="0" stop-color="#070a16"/>
              <stop offset="0.5" stop-color="#16268f"/>
              <stop offset="1" stop-color="#3f5cff"/>`;
const AMBER = `<stop offset="0" stop-color="#120e06"/>
               <stop offset="0.5" stop-color="#8a5a12"/>
               <stop offset="1" stop-color="#e8a838"/>`;

// Magnifier, filled geometry only: an annulus via evenodd, plus a stub handle.
const glassMark = `
  <path fill="${WHITE}" fill-rule="evenodd"
        d="M222 96 a134 134 0 1 1 0 268 a134 134 0 1 1 0 -268 Z
           M222 168 a62 62 0 1 0 0 124 a62 62 0 1 0 0 -124 Z"/>
  <rect x="296" y="316" width="150" height="52" rx="26"
        transform="rotate(45 296 316)" fill="${WHITE}"/>`;

// Heavy D, same construction as the earlier round: geometry, never a font.
const dMark = `
  <path fill="${WHITE}" fill-rule="evenodd" d="
    M140 104 H288 C 384 104, 432 172, 432 256 C 432 340, 384 408, 288 408 H140 Z
    M216 176 H288 C 334 176, 352 212, 352 256 C 352 300, 334 336, 288 336 H216 Z"/>`;

// Four focus corners: the reference's rotational symmetry, but the shape means
// something here — framing a subject is what scrutiny looks like. Thick arms so
// they survive downscaling, which is where thin brackets die.
const arm = 96, th = 34, off = 118;
const corner = (rot) => `
  <g transform="rotate(${rot} 256 256)">
    <rect x="${off}" y="${off}" width="${arm}" height="${th}" fill="${WHITE}"/>
    <rect x="${off}" y="${off}" width="${th}" height="${arm}" fill="${WHITE}"/>
  </g>`;
const focusMark = `
  ${[0, 90, 180, 270].map(corner).join("")}
  <circle cx="256" cy="256" r="46" fill="${WHITE}"/>`;

const variants = {
  S1: scene(BLUE, "#6d8cff", glassMark),
  S2: scene(BLUE, "#6d8cff", dMark),
  S3: scene(BLUE, "#6d8cff", focusMark),
  S4: scene(AMBER, "#ffc766", glassMark),
  S5: scene(AMBER, "#ffc766", focusMark),
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
