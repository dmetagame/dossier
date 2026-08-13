import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  METHODOLOGY_VERSION,
  SCHEMA_VERSION,
} from "../src/attest";
import {
  activeTrustedSigningKey,
  TRUSTED_SIGNING_KEYS,
  evaluateSigningKeyTrust,
  validateTrustedSigningKeyRegistry,
  type TrustedSigningKey,
} from "../src/trusted-signing-keys";

const PRODUCTION_PUBLIC_KEY =
  "oOO5AkCXfVbXwSr3j6FBlKUv6mAwCKE9SE7f_zUS6e4";
const OTHER_PUBLIC_KEY =
  "A".repeat(43);
const DOSSIER_ISSUER = { agentId: 7012, name: "Dossier" };

function entry(
  overrides: Partial<TrustedSigningKey> = {},
): TrustedSigningKey {
  return {
    id: "test-key",
    algorithm: "ed25519",
    publicKey: PRODUCTION_PUBLIC_KEY,
    issuer: DOSSIER_ISSUER,
    schemaVersions: [SCHEMA_VERSION],
    methodologyVersions: [METHODOLOGY_VERSION],
    validFrom: "2026-08-13T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function evaluate(
  overrides: Partial<Parameters<typeof evaluateSigningKeyTrust>[0]> = {},
  registry: readonly TrustedSigningKey[] = [entry()],
) {
  return evaluateSigningKeyTrust(
    {
      publicKey: PRODUCTION_PUBLIC_KEY,
      algorithm: "ed25519",
      issuer: DOSSIER_ISSUER,
      schemaVersion: SCHEMA_VERSION,
      methodologyVersion: METHODOLOGY_VERSION,
      issuedAt: "2026-08-13T12:00:00.000Z",
      now: Date.parse("2026-08-13T12:01:00.000Z"),
      ...overrides,
    },
    registry,
  );
}

describe("trusted signing-key registry", () => {
  test("contains the current production signing key as active", () => {
    const current = TRUSTED_SIGNING_KEYS.find(
      (candidate) => candidate.publicKey === PRODUCTION_PUBLIC_KEY,
    );

    assert.ok(current, "the deployed public key must be code-reviewed into the registry");
    assert.equal(current.status, "active");
    assert.deepEqual(current.issuer, DOSSIER_ISSUER);
    assert.ok(current.schemaVersions.includes(SCHEMA_VERSION));
    assert.ok(current.methodologyVersions.includes(METHODOLOGY_VERSION));
    assert.ok(Number.isFinite(Date.parse(current.validFrom)));

    const result = evaluateSigningKeyTrust({
      publicKey: PRODUCTION_PUBLIC_KEY,
      algorithm: "ed25519",
      issuer: DOSSIER_ISSUER,
      schemaVersion: SCHEMA_VERSION,
      methodologyVersion: METHODOLOGY_VERSION,
      issuedAt: "2026-08-13T12:00:00.000Z",
      now: Date.parse("2026-08-13T12:01:00.000Z"),
    });
    assert.equal(result.trusted, true);
  });

  test("accepts a key only for its registered issuer and compatible versions", () => {
    const result = evaluate();

    assert.equal(result.trusted, true);
    assert.equal(result.entry?.publicKey, PRODUCTION_PUBLIC_KEY);
    assert.match(result.reason, /trust registry/i);
  });

  test("rejects an arbitrary unregistered key", () => {
    const result = evaluate({ publicKey: OTHER_PUBLIC_KEY });

    assert.equal(result.trusted, false);
    assert.equal(result.entry, undefined);
    assert.match(result.reason, /not (?:in|present|registered|trusted)/i);
  });

  test("rejects a registered key when the report claims another issuer", () => {
    const result = evaluate({
      issuer: { agentId: 9999, name: "Not Dossier" },
    });

    assert.equal(result.trusted, false);
    assert.equal(result.entry?.publicKey, PRODUCTION_PUBLIC_KEY);
    assert.match(result.reason, /issuer/i);
  });

  test("rejects schemas outside the key entry's compatibility list", () => {
    const result = evaluate({ schemaVersion: "dossier-attestation/999" });

    assert.equal(result.trusted, false);
    assert.match(result.reason, /schema/i);
  });

  test("rejects methodologies outside the key entry's compatibility list", () => {
    const result = evaluate({ methodologyVersion: "engine/2099-01-01" });

    assert.equal(result.trusted, false);
    assert.match(result.reason, /methodology/i);
  });

  test("rejects an algorithm mismatch and a report dated too far in the future", () => {
    const algorithm = evaluate({ algorithm: "rsa" });
    const future = evaluate({
      issuedAt: "2026-08-13T12:06:00.001Z",
      now: Date.parse("2026-08-13T12:00:00.000Z"),
    });
    assert.equal(algorithm.trusted, false);
    assert.match(algorithm.reason, /algorithm/i);
    assert.equal(future.trusted, false);
    assert.match(future.reason, /future/i);
  });

  test("rejects a report issued before the key's validity begins", () => {
    const result = evaluate({ issuedAt: "2026-08-12T23:59:59.999Z" });

    assert.equal(result.trusted, false);
    assert.match(result.reason, /before|predate|not yet|valid(?:ity)? window/i);
  });

  test("rejects a report issued after an entry's validity ends", () => {
    const registry = [
      entry({
        validUntil: "2026-08-13T12:00:00.000Z",
      }),
    ];
    const result = evaluate(
      { issuedAt: "2026-08-13T12:00:00.001Z" },
      registry,
    );

    assert.equal(result.trusted, false);
    assert.match(result.reason, /after|expired|valid(?:ity)? window/i);
  });

  test("retired keys remain trusted for reports inside their historical window", () => {
    const registry = [
      entry({
        status: "retired",
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-08-01T00:00:00.000Z",
      }),
    ];
    const historical = evaluate(
      { issuedAt: "2026-07-31T23:59:59.999Z" },
      registry,
    );
    const postRetirement = evaluate(
      { issuedAt: "2026-08-01T00:00:00.001Z" },
      registry,
    );

    assert.equal(historical.trusted, true);
    assert.equal(historical.entry?.status, "retired");
    assert.equal(postRetirement.trusted, false);
  });

  test("production activation rejects malformed or already-ended entries", () => {
    assert.equal(
      activeTrustedSigningKey(PRODUCTION_PUBLIC_KEY, [entry()], {
        schemaVersion: SCHEMA_VERSION,
        methodologyVersion: METHODOLOGY_VERSION,
        now: Date.parse("2026-08-13T12:00:00.000Z"),
      })?.status,
      "active",
    );
    assert.equal(
      activeTrustedSigningKey(PRODUCTION_PUBLIC_KEY, [entry({ validFrom: "not-a-date" })]),
      undefined,
    );
    assert.equal(
      activeTrustedSigningKey(PRODUCTION_PUBLIC_KEY, [entry({ validUntil: "2026-08-14T00:00:00.000Z" })]),
      undefined,
    );
    assert.equal(
      activeTrustedSigningKey(PRODUCTION_PUBLIC_KEY, [entry({ schemaVersions: [] })]),
      undefined,
    );
  });

  test("the registry validator rejects duplicates and malformed retirement windows", () => {
    assert.deepEqual(validateTrustedSigningKeyRegistry(), []);
    const issues = validateTrustedSigningKeyRegistry([
      entry({ id: "same" }),
      entry({ id: "same", status: "retired" }),
    ]);
    assert.ok(issues.some((issue) => issue.includes("duplicate id")));
    assert.ok(issues.some((issue) => issue.includes("duplicate public key")));
    assert.ok(issues.some((issue) => issue.includes("lacks validUntil")));
  });
});
