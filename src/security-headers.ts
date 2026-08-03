// Response headers that shrink the browser attack surface.
//
// The service had none of these. That mattered most on /verify, which renders
// JSON an attacker chooses: before the DOM rewrite, a crafted ?attestation= link
// executed script on this origin, and there was no CSP to contain it. Headers
// are not a substitute for that fix, but they are what limits the blast radius
// of the next one nobody has found yet.
//
// The policy is strict because it can be: this service loads nothing from anyone
// else. No CDN, no analytics, no third-party fonts. The only scripts are two we
// inline ourselves, and they are allowed individually by hash rather than by
// opening the door with `unsafe-inline` — which on a page that renders hostile
// input would give back most of what removing innerHTML took away.

import { createHash } from "node:crypto";

/** CSP source token for an inline script, matched by content. */
export function scriptHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

/**
 * Applied to every response.
 *
 * `frame-ancestors 'none'` rather than X-Frame-Options alone, because a report
 * or a verification result framed inside someone else's page is a ready-made way
 * to present our output as theirs.
 */
export const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** For JSON and other non-document responses, nothing needs to execute at all. */
export const NON_DOCUMENT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * For our two HTML pages. Styles are inline and ours, images are data URIs, and
 * fonts come from this origin. `connect-src 'self'` is needed by the verifier,
 * which fetches the published signing key.
 */
export function documentCsp(inlineScripts: string[]): string {
  const scripts = inlineScripts.map(scriptHash).join(" ");
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
