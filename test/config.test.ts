import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  assertPaymentBypassAllowed,
  assertProductionConfig,
  preflightProductionConfig,
  signingPublicKeyFromSeed,
} from "../src/config";

const archives: string[] = [];
after(() => archives.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function production(overrides: Record<string, string | undefined> = {}) {
  const archive = mkdtempSync(join(tmpdir(), "dossier-config-"));
  archives.push(archive);
  const seed = "11".repeat(32);
  return {
    NODE_ENV: "production",
    DEV_SKIP_PAYMENT: "0",
    PUBLIC_ORIGIN: "https://dossier.rouma.xyz",
    X402_NETWORK: "eip155:196",
    DOSSIER_PRICE: "$0.01",
    PAY_TO: "0x51c25782af63381056cd1c3c59c0544628d67697",
    OKX_API_KEY: "facilitator-api-key",
    OKX_SECRET_KEY: "facilitator-secret-key",
    OKX_PASSPHRASE: "facilitator-passphrase",
    INTERNAL_KEY: "i".repeat(32),
    ARCHIVE_DIR: archive,
    ARCHIVE_MAC_KEY: "a".repeat(32),
    ARCHIVE_MAC_REQUIRED: "1",
    PAYMENT_REPLAY_KEY: "r".repeat(32),
    SIGNING_KEY: seed,
    DOSSIER_SIGNING_PUBLIC_KEY: signingPublicKeyFromSeed(seed)!,
    RATE_LIMIT_MODE: "enforce",
    PORT: "3000",
    ...overrides,
  };
}

function fields(result: ReturnType<typeof preflightProductionConfig>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.field);
}

describe("standalone production configuration", () => {
  test("accepts a complete, independent paid configuration", () => {
    const result = preflightProductionConfig(production());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.mode, "production");
  });

  test("the bypass is restricted to explicit development and test processes", () => {
    assert.equal(
      preflightProductionConfig({
        NODE_ENV: "test",
        DEV_SKIP_PAYMENT: "1",
      }).ok,
      true,
    );
    assert.equal(
      preflightProductionConfig({
        NODE_ENV: "development",
        DEV_SKIP_PAYMENT: "1",
      }).ok,
      true,
    );
    const productionBypass = preflightProductionConfig({
      NODE_ENV: "production",
      DEV_SKIP_PAYMENT: "1",
    });
    assert.equal(productionBypass.ok, false);
    assert.ok(fields(productionBypass).includes("DEV_SKIP_PAYMENT"));

    const accidentalLocalPaidStart = preflightProductionConfig({
      NODE_ENV: "development",
    });
    assert.equal(accidentalLocalPaidStart.ok, false);
    assert.ok(fields(accidentalLocalPaidStart).includes("DEV_SKIP_PAYMENT"));

    assert.doesNotThrow(() =>
      assertPaymentBypassAllowed({ NODE_ENV: "test", DEV_SKIP_PAYMENT: "1" }),
    );
    assert.throws(
      () =>
        assertPaymentBypassAllowed({
          NODE_ENV: "production",
          DEV_SKIP_PAYMENT: "1",
        }),
      /DEV_SKIP_PAYMENT/,
    );
  });

  test("missing and malformed paid settings fail together before startup", () => {
    const result = preflightProductionConfig(
      production({
        PUBLIC_ORIGIN: "http://dossier.example/path",
        X402_NETWORK: "eip155:1",
        DOSSIER_PRICE: "free",
        PAY_TO: "0x0",
        OKX_SECRET_KEY: "",
        INTERNAL_KEY: "short",
        ARCHIVE_MAC_REQUIRED: "0",
        SIGNING_KEY: "not-a-seed",
        DOSSIER_SIGNING_PUBLIC_KEY: "not-a-key",
        RATE_LIMIT_MODE: "observe",
        PORT: "70000",
      }),
    );
    assert.equal(result.ok, false);
    for (const field of [
      "PUBLIC_ORIGIN",
      "X402_NETWORK",
      "DOSSIER_PRICE",
      "PAY_TO",
      "OKX_SECRET_KEY",
      "INTERNAL_KEY",
      "ARCHIVE_MAC_REQUIRED",
      "SIGNING_KEY",
      "DOSSIER_SIGNING_PUBLIC_KEY",
      "RATE_LIMIT_MODE",
      "PORT",
    ]) {
      assert.ok(fields(result).includes(field), `${field} must fail preflight`);
    }
  });

  test("production uses the exact registered origin, price and payout wallet", () => {
    const result = preflightProductionConfig(
      production({
        PUBLIC_ORIGIN: "https://other.example",
        DOSSIER_PRICE: "$0.02",
        PAY_TO: "0x61c25782af63381056cd1c3c59c0544628d67697",
      }),
    );
    assert.equal(result.ok, false);
    for (const field of ["PUBLIC_ORIGIN", "DOSSIER_PRICE", "PAY_TO"]) {
      assert.ok(fields(result).includes(field), `${field} must be pinned`);
    }
  });

  test("legacy archive MAC material is rejected by the running-service preflight", () => {
    const result = preflightProductionConfig(
      production({ ARCHIVE_LEGACY_MAC_KEY: "legacy-only-key" }),
    );
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("ARCHIVE_LEGACY_MAC_KEY"));
  });

  test("local bypass still validates listener and rate-limit enums", () => {
    const result = preflightProductionConfig({
      NODE_ENV: "development",
      DEV_SKIP_PAYMENT: "1",
      PORT: "70000",
      RATE_LIMIT_MODE: "bad",
    });
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("PORT"));
    assert.ok(fields(result).includes("RATE_LIMIT_MODE"));
  });

  test("explicit empty control values fail instead of silently defaulting", () => {
    const result = preflightProductionConfig(
      production({ PORT: "", RATE_LIMIT_MODE: "", DEV_SKIP_PAYMENT: "" }),
    );
    assert.equal(result.ok, false);
    for (const field of ["PORT", "RATE_LIMIT_MODE", "DEV_SKIP_PAYMENT"]) {
      assert.ok(fields(result).includes(field), `${field} must reject an explicit empty value`);
    }
  });

  test("production requires explicit port and enforced rate limiting", () => {
    const result = preflightProductionConfig(
      production({ PORT: undefined, RATE_LIMIT_MODE: undefined }),
    );
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("PORT"));
    assert.ok(fields(result).includes("RATE_LIMIT_MODE"));
  });

  test("production listener must match the reverse proxy target", () => {
    const result = preflightProductionConfig(production({ PORT: "8787" }));
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("PORT"));
  });

  test("the configured public signing key must correspond to the private seed", () => {
    const other = signingPublicKeyFromSeed("22".repeat(32));
    const result = preflightProductionConfig(
      production({ DOSSIER_SIGNING_PUBLIC_KEY: other! }),
    );
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("DOSSIER_SIGNING_PUBLIC_KEY"));
  });

  test("archive, replay, internal and signing secrets must be independent", () => {
    const result = preflightProductionConfig(
      production({
        PAYMENT_REPLAY_KEY: "a".repeat(32),
        INTERNAL_KEY: "a".repeat(32),
      }),
    );
    assert.equal(result.ok, false);
    // The first use is accepted; each later reuse is named explicitly.
    assert.ok(fields(result).includes("PAYMENT_REPLAY_KEY"));
  });

  test("the archive path must already exist and be an absolute directory", () => {
    const result = preflightProductionConfig(
      production({ ARCHIVE_DIR: "relative/archive" }),
    );
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("ARCHIVE_DIR"));
  });

  test("the archive path cannot be redirected through a symlink", () => {
    const target = mkdtempSync(join(tmpdir(), "dossier-config-target-"));
    const parent = mkdtempSync(join(tmpdir(), "dossier-config-link-"));
    archives.push(target, parent);
    const link = join(parent, "archive");
    symlinkSync(target, link);
    const result = preflightProductionConfig(production({ ARCHIVE_DIR: link }));
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("ARCHIVE_DIR"));
  });

  test("the archive directory must be private before startup", () => {
    const archive = mkdtempSync(join(tmpdir(), "dossier-config-mode-"));
    archives.push(archive);
    chmodSync(archive, 0o755);
    const result = preflightProductionConfig(production({ ARCHIVE_DIR: archive }));
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes("ARCHIVE_DIR"));
  });

  test("assertion reports field names without secret values", () => {
    const apiSecret = "must-never-appear-in-the-error";
    assert.throws(
      () =>
        assertProductionConfig(
          production({ OKX_API_KEY: apiSecret, OKX_SECRET_KEY: "" }),
        ),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /OKX_SECRET_KEY/);
        assert.equal(message.includes(apiSecret), false);
        return true;
      },
    );
  });
});
