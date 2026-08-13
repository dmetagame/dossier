// Code-reviewed trust anchors for Dossier report signatures.
//
// A signature can be perfectly valid for a key supplied by the same report.
// That proves only self-consistency.  Issuer trust comes from this append-only
// registry, which is shipped with the verifier and reviewed like any other code
// change.  Rotate by retiring an entry and appending the replacement; never
// delete an old key, because historical reports still need their issue-time
// trust decision.

export interface DossierIssuer {
  agentId: number;
  name: string;
}

export interface TrustedSigningKey {
  /** Human-readable stable identifier for reviews and logs. */
  id: string;
  algorithm: "ed25519";
  /** Raw 32-byte Ed25519 key encoded as base64url. */
  publicKey: string;
  issuer: DossierIssuer;
  schemaVersions: readonly string[];
  methodologyVersions: readonly string[];
  /** Inclusive issue-time boundary. */
  validFrom: string;
  /** Exclusive issue-time boundary, set when a key is retired. */
  validUntil?: string;
  status: "active" | "retired";
  note?: string;
}

const CURRENT_PRODUCTION_KEY: TrustedSigningKey = {
  id: "dossier-production-2026-07-27",
  algorithm: "ed25519",
  publicKey: "oOO5AkCXfVbXwSr3j6FBlKUv6mAwCKE9SE7f_zUS6e4",
  issuer: { agentId: 7012, name: "Dossier" },
  schemaVersions: ["dossier-attestation/1", "dossier-attestation/2"],
  methodologyVersions: ["engine/2026-07-27", "engine/2026-08-03"],
  // This is the earliest preserved production attestation carrying this key.
  // It is deliberately the exact observed boundary rather than an invented
  // claim that the key was trusted before evidence exists.
  validFrom: "2026-07-27T19:28:23.438Z",
  status: "active",
  note: "Initial production Dossier signing key.",
};

/** Append only: preserve retired keys and their historical validity windows. */
export const TRUSTED_SIGNING_KEYS: readonly TrustedSigningKey[] = Object.freeze([
  Object.freeze(CURRENT_PRODUCTION_KEY),
]);

export interface SigningKeyTrustInput {
  publicKey?: string;
  algorithm?: string;
  issuer?: DossierIssuer;
  schemaVersion?: string;
  methodologyVersion?: string;
  issuedAt?: string;
  /** Verification clock seam for deterministic tests; defaults to Date.now(). */
  now?: number;
}

export const MAX_ISSUE_TIME_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type SigningKeyTrustResult =
  | {
      trusted: true;
      reason: string;
      entry: TrustedSigningKey;
    }
  | {
      trusted: false;
      reason: string;
      entry?: TrustedSigningKey;
    };

function result(
  trusted: boolean,
  reason: string,
  entry?: TrustedSigningKey,
): SigningKeyTrustResult {
  return trusted && entry
    ? { trusted: true, reason, entry }
    : {
        trusted: false,
        reason,
        ...(entry ? { entry } : {}),
      };
}

function exactIsoInstant(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  // Require a timezone and a real round-trippable ISO timestamp. Date.parse is
  // otherwise permissive enough to silently normalise invalid calendar dates.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const reparsed = new Date(time);
  if (Number.isNaN(reparsed.getTime())) return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return null;
  // Date.parse normalises values such as February 31. Reconstructing the
  // represented local calendar components makes that normalisation visible.
  const offset = match[8] === "Z"
    ? 0
    : (match[8]![0] === "-" ? -1 : 1) *
      (Number(match[8]!.slice(1, 3)) * 60 + Number(match[8]!.slice(4, 6)));
  const local = new Date(time + offset * 60_000);
  if (
    local.getUTCFullYear() !== Number(match[1]) ||
    local.getUTCMonth() + 1 !== Number(match[2]) ||
    local.getUTCDate() !== Number(match[3]) ||
    local.getUTCHours() !== Number(match[4]) ||
    local.getUTCMinutes() !== Number(match[5]) ||
    local.getUTCSeconds() !== Number(match[6])
  ) {
    return null;
  }
  return time;
}

function sameIssuer(actual: DossierIssuer | undefined, expected: DossierIssuer): boolean {
  return Boolean(
    actual &&
      actual.agentId === expected.agentId &&
      actual.name === expected.name,
  );
}

/**
 * Decide issuer trust independently from cryptographic verification.
 *
 * The issue time is signed, so a retired key remains useful for reports issued
 * inside its historical window.  A compromised key needs a separate incident
 * response and explicit cutoff; merely changing `status` must never rewrite
 * the meaning of already-issued reports.
 */
export function evaluateSigningKeyTrust(
  input: SigningKeyTrustInput,
  registry: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): SigningKeyTrustResult {
  if (!input.publicKey) {
    return result(false, "The report does not identify a signing key.");
  }
  const entry = registry.find((candidate) => candidate.publicKey === input.publicKey);
  if (!entry) {
    return result(
      false,
      "The signature is self-consistent, but its key is not registered in the code-reviewed Dossier trust registry.",
    );
  }
  if (input.algorithm !== entry.algorithm) {
    return result(
      false,
      "The signed algorithm does not match this signing key's registry entry.",
      entry,
    );
  }
  if (!sameIssuer(input.issuer, entry.issuer)) {
    return result(
      false,
      "The signing key is registered, but the signed issuer identity does not match its registry entry.",
      entry,
    );
  }
  if (!input.schemaVersion || !entry.schemaVersions.includes(input.schemaVersion)) {
    return result(
      false,
      "The signing key is not trusted for this attestation schema version.",
      entry,
    );
  }
  if (
    !input.methodologyVersion ||
    !entry.methodologyVersions.includes(input.methodologyVersion)
  ) {
    return result(
      false,
      "The signing key is not trusted for this methodology version.",
      entry,
    );
  }
  const issuedAt = exactIsoInstant(input.issuedAt);
  if (issuedAt === null) {
    return result(
      false,
      "The signed issue time is missing or is not a valid timezone-qualified timestamp.",
      entry,
    );
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    return result(false, "The verifier clock is invalid.", entry);
  }
  if (issuedAt > now + MAX_ISSUE_TIME_CLOCK_SKEW_MS) {
    return result(
      false,
      "The report's signed issue time is too far in the future for issuer trust.",
      entry,
    );
  }
  const validFrom = exactIsoInstant(entry.validFrom);
  const validUntil = entry.validUntil
    ? exactIsoInstant(entry.validUntil)
    : null;
  if (validFrom === null || (entry.validUntil && validUntil === null)) {
    return result(
      false,
      "The code-reviewed trust entry has an invalid validity window.",
      entry,
    );
  }
  if (entry.status === "retired" && !entry.validUntil) {
    return result(
      false,
      "The retired signing-key entry has no explicit end to its trusted validity window.",
      entry,
    );
  }
  if (issuedAt < validFrom) {
    return result(
      false,
      "The report claims to predate this signing key's trusted validity window.",
      entry,
    );
  }
  if (validUntil !== null && issuedAt >= validUntil) {
    return result(
      false,
      "The report was issued after this signing key's trusted validity window ended.",
      entry,
    );
  }
  return result(
    true,
    entry.status === "retired"
      ? "The signature is from a retired Dossier key and is trusted for this historical issue time."
      : "The signature key, issuer, versions, and issue time match the code-reviewed Dossier trust registry.",
    entry,
  );
}

/** Active entries are the only keys a production process may use for new reports. */
export function activeTrustedSigningKey(
  publicKey: string,
  registry: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
  requirement: {
    schemaVersion?: string;
    methodologyVersion?: string;
    now?: number;
  } = {},
): TrustedSigningKey | undefined {
  const now = requirement.now ?? Date.now();
  if (!Number.isFinite(now)) return undefined;
  return registry.find(
    (entry) =>
      entry.publicKey === publicKey &&
      entry.algorithm === "ed25519" &&
      entry.status === "active" &&
      !entry.validUntil &&
      exactIsoInstant(entry.validFrom) !== null &&
      exactIsoInstant(entry.validFrom)! <= now &&
      entry.schemaVersions.length > 0 &&
      entry.methodologyVersions.length > 0 &&
      (!requirement.schemaVersion ||
        entry.schemaVersions.includes(requirement.schemaVersion)) &&
      (!requirement.methodologyVersion ||
        entry.methodologyVersions.includes(requirement.methodologyVersion)),
  );
}

export function validateTrustedSigningKeyRegistry(
  registry: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const publicKeys = new Set<string>();
  for (const entry of registry) {
    if (ids.has(entry.id)) issues.push(`duplicate id: ${entry.id}`);
    ids.add(entry.id);
    if (publicKeys.has(entry.publicKey)) {
      issues.push(`duplicate public key: ${entry.id}`);
    }
    publicKeys.add(entry.publicKey);
    if (entry.algorithm !== "ed25519") issues.push(`unsupported algorithm: ${entry.id}`);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(entry.publicKey) ||
      Buffer.from(entry.publicKey, "base64url").length !== 32
    ) {
      issues.push(`invalid public key: ${entry.id}`);
    }
    const validFrom = exactIsoInstant(entry.validFrom);
    const validUntil = entry.validUntil ? exactIsoInstant(entry.validUntil) : null;
    if (validFrom === null) issues.push(`invalid validFrom: ${entry.id}`);
    if (entry.validUntil && validUntil === null) issues.push(`invalid validUntil: ${entry.id}`);
    if (validFrom !== null && validUntil !== null && validUntil <= validFrom) {
      issues.push(`non-positive validity window: ${entry.id}`);
    }
    if (entry.status === "active" && entry.validUntil) {
      issues.push(`active key has validUntil: ${entry.id}`);
    }
    if (entry.status === "retired" && !entry.validUntil) {
      issues.push(`retired key lacks validUntil: ${entry.id}`);
    }
    if (entry.schemaVersions.length === 0) issues.push(`no schema versions: ${entry.id}`);
    if (entry.methodologyVersions.length === 0) {
      issues.push(`no methodology versions: ${entry.id}`);
    }
  }
  return issues;
}

const registryIssues = validateTrustedSigningKeyRegistry();
if (registryIssues.length) {
  throw new Error(`invalid trusted signing-key registry: ${registryIssues.join("; ")}`);
}
