// Signed attestations, so a report can be checked by someone who does not
// trust us.
//
// Recovery already proves the server kept the same bytes. It does not prove who
// issued a report, or what the sources actually said at the time. This does:
// every report carries a canonical hash of its own inputs and findings, an
// Ed25519 signature over that hash, and a per-source record of when each source
// was read and what it returned. The public key is published at a well-known
// URL, and anyone can verify a report with the twelve lines of Node in the
// README, or in their browser at /verify, without a wallet or an account.
//
// Deliberate limitation, stated rather than hidden: the settlement transaction
// is NOT inside the signature. The report is produced before the payment
// settles — that ordering is what guarantees a failed request cannot charge —
// so no signature made at issue time can commit to a transaction that does not
// exist yet. Recovery returns the transaction alongside the attestation, as a
// server-asserted field, and the verifier reports it as such.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** Bump when the meaning of any signed field changes. */
export const SCHEMA_VERSION = "dossier-attestation/2";
/** Bump when the scoring rules change, so old reports stay interpretable. */
export const METHODOLOGY_VERSION = "engine/2026-08-03";

// An Ed25519 private key is a 32-byte seed. Carrying PEM through systemd's
// EnvironmentFile is painful, so the seed travels as 64 hex characters and the
// fixed PKCS8 prefix is reattached here.
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

export interface SourceObservation {
  /** e.g. "goplus", "dexscreener", "xlayer-rpc" */
  source: string;
  /** The endpoint that was read, without any key material. */
  url?: string;
  status: string;
  /** ISO time the response was received. */
  retrievedAt?: string;
  /** sha256 of the raw response body, so the observation is pinnable. */
  responseSha256?: string;
}

export interface AttestationPayload {
  schemaVersion: string;
  methodologyVersion: string;
  reportId: string;
  /** sha256 of the canonicalised request (token, chain), excluding `format`. */
  requestSha256: string;
  /**
   * sha256 of the canonical report body, meaning the whole document except this
   * attestation.
   *
   * Without it the signature covered a summary: verdict, coverage, size cap,
   * check statuses, token, block, source statuses. Liquidity, holders, taxes,
   * owner, proxy implementation, the written explanations and the token's own
   * name and supply were all outside it, so any of them could be altered while
   * the verifier still reported a valid signature. Committing to a hash of the
   * body makes the signature cover the document instead of describing it.
   */
  reportSha256: string;
  token: { chain: string; address: string };
  /** The findings this signature commits to. */
  result: {
    verdict: string;
    coverage: number;
    maxSizeUsd: number | null;
    checks: Record<string, string>;
  };
  /** Chain height the on-chain reads were taken at, when an RPC answered. */
  chainId?: number;
  blockNumber?: number;
  observations: SourceObservation[];
  issuedAt: string;
  issuer: { agentId: number; name: string };
}

export interface Attestation {
  payload: AttestationPayload;
  /** sha256 of the canonical JSON of `payload`. */
  payloadSha256: string;
  /** Ed25519 over the canonical JSON bytes. Absent when unsigned. */
  signature?: string;
  /** Base64url public key, matching /.well-known/dossier-signing-key.json */
  publicKey?: string;
  algorithm?: "ed25519";
  /** Why a report is unsigned, when it is. */
  unsignedReason?: string;
  verifyWith: string;
}

/**
 * Deterministic JSON: object keys sorted at every depth, no whitespace.
 *
 * Two people hashing the same payload must get the same digest, so the encoding
 * cannot depend on property insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256 = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");

const b64url = (b: Buffer): string => b.toString("base64url");

interface Keys {
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeyB64: string;
}

let cached: Keys | null | undefined;

/** Resolved on use so a key can be added without a code change. */
function keys(): Keys | null {
  if (cached !== undefined) return cached;
  const seed = (process.env.SIGNING_KEY ?? "").trim();
  if (!/^[0-9a-f]{64}$/i.test(seed)) {
    cached = null;
    return null;
  }
  try {
    const der = Buffer.concat([Buffer.from(PKCS8_ED25519_PREFIX, "hex"), Buffer.from(seed, "hex")]);
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    // Export via PEM: the KeyObject overload of createPublicKey is not in the
    // installed @types/node, and a PEM round trip is unambiguous.
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const jwk = createPublicKey(pem).export({ format: "jwk" }) as unknown as { x?: string };
    cached = { privateKey, publicKeyB64: jwk.x ?? "" };
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam: forget the cached key after changing the environment. */
export function resetKeys(): void {
  cached = undefined;
}

export function publicKey(): { algorithm: "ed25519"; publicKey: string } | null {
  const k = keys();
  return k ? { algorithm: "ed25519", publicKey: k.publicKeyB64 } : null;
}

export function attest(payload: AttestationPayload, verifyUrl: string): Attestation {
  const canonical = canonicalJson(payload);
  const payloadSha256 = sha256(canonical);
  const k = keys();
  if (!k) {
    return {
      payload,
      payloadSha256,
      unsignedReason:
        "No signing key is configured on this instance, so this report carries a hash but no signature.",
      verifyWith: verifyUrl,
    };
  }
  return {
    payload,
    payloadSha256,
    signature: b64url(sign(null, Buffer.from(canonical, "utf8"), k.privateKey)),
    publicKey: k.publicKeyB64,
    algorithm: "ed25519",
    verifyWith: verifyUrl,
  };
}

export interface VerifyResult {
  hashMatches: boolean;
  signatureValid: boolean | null;
  /** True only when the payload hashes correctly AND the signature checks out. */
  verified: boolean;
  reason: string;
  recomputedSha256: string;
}

/**
 * Verifies an attestation against a public key.
 *
 * Takes the key as an argument rather than reading our own: a verifier that
 * trusts whatever key the server hands it is not a verifier. Callers should
 * pin the key from /.well-known/dossier-signing-key.json, or from anywhere else
 * they already trust.
 */
export function verifyAttestation(att: Attestation, expectedPublicKey?: string): VerifyResult {
  const recomputedSha256 = sha256(canonicalJson(att.payload));
  const hashMatches = recomputedSha256 === att.payloadSha256;
  if (!hashMatches) {
    return {
      hashMatches,
      signatureValid: null,
      verified: false,
      reason: "The payload does not hash to the value in the attestation: it has been altered.",
      recomputedSha256,
    };
  }
  const key = expectedPublicKey ?? att.publicKey;
  if (!att.signature || !key) {
    return {
      hashMatches,
      signatureValid: null,
      verified: false,
      reason: att.signature
        ? "No public key supplied to check the signature against."
        : "This report is unsigned; its hash matches but nothing attests to who issued it.",
      recomputedSha256,
    };
  }
  if (expectedPublicKey && att.publicKey && expectedPublicKey !== att.publicKey) {
    return {
      hashMatches,
      signatureValid: false,
      verified: false,
      reason: "The report was signed by a different key than the one you pinned.",
      recomputedSha256,
    };
  }
  let signatureValid = false;
  try {
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key } as unknown as JsonWebKey,
      format: "jwk",
    });
    signatureValid = verify(
      null,
      Buffer.from(canonicalJson(att.payload), "utf8"),
      pub,
      Buffer.from(att.signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  return {
    hashMatches,
    signatureValid,
    verified: signatureValid,
    reason: signatureValid
      ? "The payload hashes correctly and the signature is valid for this key."
      : "The signature is not valid for this payload and key.",
    recomputedSha256,
  };
}
