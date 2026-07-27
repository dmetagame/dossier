// Self-hosted webfonts, embedded in the bundle.
//
// The service deploys as a single file (esbuild -> dist/server.mjs, run by
// systemd), so there is no static-asset directory to serve from. The three
// woff2 subsets are emitted as a TypeScript module by scripts/build-assets.mjs
// and decoded once here, then served from memory. That keeps the one-file deploy intact and, more to the
// point, keeps fonts on our own origin: this page takes payments, and a
// third-party font CDN would put a request to someone else's server on it.
//
// Latin subsets only, which is what the page actually renders.

import { createHash } from "node:crypto";
import { SERIF_B64, SANS_B64, MONO_B64 } from "./generated/fonts-data";

interface Font {
  /** URL path, content-hashed so it can be cached forever and still change. */
  path: string;
  body: Buffer;
}

function font(name: string, b64: string): Font {
  const body = Buffer.from(b64, "base64");
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return { path: `/f/${name}-${hash}.woff2`, body };
}

export const FONTS: Record<string, Font> = {
  serif: font("instrument-serif", SERIF_B64),
  sans: font("geist", SANS_B64),
  mono: font("geist-mono", MONO_B64),
};

const byPath = new Map(Object.values(FONTS).map((f) => [f.path, f]));

export function fontByPath(path: string): Font | undefined {
  return byPath.get(path);
}

/**
 * @font-face rules for the landing page.
 *
 * `swap` so text is readable before the fonts land. Only the display face is
 * preloaded (see the <link> in site.ts): it sets the largest text on the page,
 * so a swap there is the one that would actually be seen.
 */
export const FONT_FACE_CSS = `
@font-face{font-family:"Instrument Serif";src:url(${FONTS.serif!.path}) format("woff2");
  font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"Geist";src:url(${FONTS.sans!.path}) format("woff2");
  font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(${FONTS.mono!.path}) format("woff2");
  font-weight:100 900;font-style:normal;font-display:swap}`;

/** Total bytes shipped to a cold visitor, for the weight budget. */
export const FONT_BYTES = Object.values(FONTS).reduce((n, f) => n + f.body.length, 0);
