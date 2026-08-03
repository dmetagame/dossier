// Signed attestations. The point is that someone who does not trust us can
// still check a report, so these tests are written from that person's side:
// does tampering get caught, and does a valid signature actually mean anything.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  attest,
  canonicalJson,
  publicKey,
  resetKeys,
  sha256,
  verifyAttestation,
  SCHEMA_VERSION,
  type AttestationPayload,
} from "../src/attest";

const SEED_A = "11".repeat(32);
const SEED_B = "22".repeat(32);

const payload = (over: Partial<AttestationPayload> = {}): AttestationPayload => ({
  schemaVersion: "dossier-attestation/1",
  methodologyVersion: "engine/2026-07-27",
  reportId: "6a3f1e2c-0000-4000-8000-000000000001",
  requestSha256: sha256("request"),
  reportSha256: sha256("report-body"),
  token: { chain: "bsc", address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" },
  result: {
    verdict: "caution",
    coverage: 1,
    maxSizeUsd: 19_395,
    checks: { honeypot: "warn", liquidity: "pass" },
  },
  chainId: 56,
  blockNumber: 66_000_000,
  observations: [
    { source: "goplus", status: "ok", retrievedAt: "2026-07-27T00:00:00.000Z", responseSha256: sha256("g") },
    { source: "dexscreener", status: "ok", retrievedAt: "2026-07-27T00:00:01.000Z", responseSha256: sha256("d") },
  ],
  issuedAt: "2026-07-27T00:00:02.000Z",
  issuer: { agentId: 7012, name: "Dossier" },
  ...over,
});

beforeEach(() => {
  process.env.SIGNING_KEY = SEED_A;
  resetKeys();
});

describe("canonical encoding", () => {
  test("key order cannot change the bytes", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  });

  test("it is stable at depth and through arrays", () => {
    const x = { z: [{ b: 1, a: [3, { d: 4, c: 5 }] }], y: null };
    const y = { y: null, z: [{ a: [3, { c: 5, d: 4 }], b: 1 }] };
    assert.equal(canonicalJson(x), canonicalJson(y));
  });

  test("undefined values are omitted, so an absent field is not a different document", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  });

  test("different values really do produce different bytes", () => {
    assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  });
});

describe("signing", () => {
  test("a fresh attestation verifies against its own key", () => {
    const att = attest(payload(), "https://x/verify");
    assert.ok(att.signature);
    assert.equal(att.algorithm, "ed25519");
    const r = verifyAttestation(att);
    assert.equal(r.verified, true);
    assert.equal(r.hashMatches, true);
    assert.equal(r.signatureValid, true);
  });

  test("the same payload signs identically, so reports are reproducible", () => {
    assert.equal(attest(payload(), "u").signature, attest(payload(), "u").signature);
  });

  test("the published key is the one that signed", () => {
    const att = attest(payload(), "u");
    assert.equal(publicKey()?.publicKey, att.publicKey);
    assert.equal(verifyAttestation(att, publicKey()!.publicKey).verified, true);
  });
});

describe("tampering is caught", () => {
  test("changing the verdict breaks the hash", () => {
    const att = attest(payload(), "u");
    const forged = { ...att, payload: payload({ result: { ...payload().result, verdict: "proceed" } }) };
    const r = verifyAttestation(forged);
    assert.equal(r.verified, false);
    assert.equal(r.hashMatches, false);
    assert.match(r.reason, /altered/);
  });

  test("changing a source observation breaks the hash", () => {
    const att = attest(payload(), "u");
    const forged = {
      ...att,
      payload: payload({ observations: [{ source: "goplus", status: "ok", responseSha256: sha256("different") }] }),
    };
    assert.equal(verifyAttestation(forged).verified, false);
  });

  test("keeping the payload but swapping the hash still fails, because the signature covers the payload", () => {
    const att = attest(payload(), "u");
    const forgedPayload = payload({ result: { ...payload().result, maxSizeUsd: 999_999 } });
    const forged = { ...att, payload: forgedPayload, payloadSha256: sha256(canonicalJson(forgedPayload)) };
    const r = verifyAttestation(forged);
    assert.equal(r.hashMatches, true, "the attacker can of course recompute a hash");
    assert.equal(r.signatureValid, false, "but not a signature");
    assert.equal(r.verified, false);
  });

  test("a signature from another key is rejected", () => {
    process.env.SIGNING_KEY = SEED_B;
    resetKeys();
    const other = attest(payload(), "u");
    process.env.SIGNING_KEY = SEED_A;
    resetKeys();
    const mine = publicKey()!.publicKey;
    const r = verifyAttestation(other, mine);
    assert.equal(r.verified, false);
    assert.match(r.reason, /different key/);
  });

  test("a verifier that pins a key is not fooled by a key inside the report", () => {
    // The attack: sign with your own key and ship your public key in the file.
    process.env.SIGNING_KEY = SEED_B;
    resetKeys();
    const forged = attest(payload(), "u");
    assert.equal(verifyAttestation(forged).verified, true, "self-consistent, as an attacker would make it");
    process.env.SIGNING_KEY = SEED_A;
    resetKeys();
    assert.equal(
      verifyAttestation(forged, publicKey()!.publicKey).verified,
      false,
      "but not against the key the reader pinned",
    );
  });
});

describe("without a signing key", () => {
  test("reports still carry a hash, and say plainly that they are unsigned", () => {
    delete process.env.SIGNING_KEY;
    resetKeys();
    const att = attest(payload(), "u");
    assert.equal(att.signature, undefined);
    assert.equal(att.payloadSha256, sha256(canonicalJson(payload())));
    assert.match(att.unsignedReason ?? "", /no signature/i);
    assert.equal(publicKey(), null);
  });

  test("an unsigned report never reports as verified", () => {
    delete process.env.SIGNING_KEY;
    resetKeys();
    const r = verifyAttestation(attest(payload(), "u"));
    assert.equal(r.verified, false);
    assert.equal(r.hashMatches, true);
    assert.match(r.reason, /unsigned/);
  });

  test("a malformed key is treated as no key, not as a crash", () => {
    process.env.SIGNING_KEY = "not-a-seed";
    resetKeys();
    assert.equal(publicKey(), null);
    assert.equal(attest(payload(), "u").signature, undefined);
  });
});

// The signature used to cover a summary of the report: verdict, coverage, size
// cap, check statuses, token, block, source statuses. Liquidity, holders, taxes,
// owner, proxy implementation, the written explanations and the token's own name
// and supply all sat outside it, so any of them could be altered while the
// verifier still announced a valid signature.
describe("the signature covers the whole report", () => {
  const body = {
    title: "Due-Diligence Dossier — CAKE",
    token: { chain: "bsc", address: "0xabc", liquidityUsd: 1_000_000, holderCount: 500 },
    security: { proxy: true, ownerRenounced: false },
    riskVerdict: { verdict: "caution", reasons: ["upgradeable proxy"] },
  };

  test("the payload commits to a hash of the body", () => {
    const digest = sha256(canonicalJson(body));
    const a = attest(payload({ reportSha256: digest }), "https://x/verify");
    assert.equal(a.payload.reportSha256, digest);
    assert.equal(verifyAttestation(a).verified, true);
  });

  test("changing a figure outside the summary breaks the report hash", () => {
    const digest = sha256(canonicalJson(body));
    // The exact attack the old scope allowed: liquidity inflated, proxy denied,
    // owner declared renounced. None of these appear in the signed summary.
    for (const tampered of [
      { ...body, token: { ...body.token, liquidityUsd: 50_000_000 } },
      { ...body, security: { ...body.security, proxy: false } },
      { ...body, security: { ...body.security, ownerRenounced: true } },
      { ...body, riskVerdict: { ...body.riskVerdict, reasons: ["nothing of concern"] } },
    ]) {
      assert.notEqual(
        sha256(canonicalJson(tampered)),
        digest,
        "an altered report must not hash to the signed value",
      );
    }
  });

  test("the attestation itself is not part of what it commits to", () => {
    // Otherwise the hash could never be computed: it would depend on itself.
    const digest = sha256(canonicalJson(body));
    const a = attest(payload({ reportSha256: digest }), "https://x/verify");
    const full = { ...body, attestation: a };
    const { attestation, ...rest } = full;
    assert.equal(sha256(canonicalJson(rest)), a.payload.reportSha256);
  });

  test("the schema version moved, so old and new reports are distinguishable", () => {
    assert.match(SCHEMA_VERSION, /\/2$/);
  });
});
