import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { METHODOLOGY_VERSION, SCHEMA_VERSION } from "./attest";
import {
  activeTrustedSigningKey,
  TRUSTED_SIGNING_KEYS,
  type TrustedSigningKey,
} from "./trusted-signing-keys";

// The standalone server is the paid production service. Its configuration is
// validated before it takes the archive lease or opens a listener (server.ts).
// Keeping that decision here gives deploy preflights and tests the exact same
// rules without importing the HTTP app or writing a probe into the archive.

export const SUPPORTED_PAYMENT_NETWORKS = ["eip155:196"] as const;
export const PRODUCTION_PUBLIC_ORIGIN = "https://dossier.rouma.xyz";
export const PRODUCTION_PRICE = "$0.01";
export const PRODUCTION_PAY_TO =
  "0x51c25782af63381056cd1c3c59c0544628d67697";
export const PRODUCTION_PORT = 3000;
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const LOCAL_BYPASS_ENVIRONMENTS = new Set(["development", "test"]);

export function paymentBypassAllowed(
  env: Environment = process.env,
): boolean {
  return (
    value(env, "DEV_SKIP_PAYMENT") === "1" &&
    LOCAL_BYPASS_ENVIRONMENTS.has(value(env, "NODE_ENV"))
  );
}

export function assertPaymentBypassAllowed(
  env: Environment = process.env,
): void {
  if (
    value(env, "DEV_SKIP_PAYMENT") === "1" &&
    !paymentBypassAllowed(env)
  ) {
    throw new Error(
      "DEV_SKIP_PAYMENT may be enabled only when NODE_ENV is explicitly development or test",
    );
  }
}

export interface ConfigurationIssue {
  field: string;
  message: string;
}

export type ProductionConfigPreflight =
  | {
      ok: true;
      mode: "production" | "local_bypass";
      signingPublicKey?: string;
    }
  | {
      ok: false;
      mode: "production" | "local_bypass";
      issues: ConfigurationIssue[];
    };

type Environment = Record<string, string | undefined>;

function present(env: Environment, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined;
}

function value(env: Environment, name: string): string {
  return env[name] ?? "";
}

function required(
  env: Environment,
  issues: ConfigurationIssue[],
  name: string,
): string {
  const raw = value(env, name);
  if (!raw.trim()) {
    issues.push({ field: name, message: "is required" });
    return "";
  }
  if (raw !== raw.trim()) {
    issues.push({ field: name, message: "must not have surrounding whitespace" });
  }
  return raw;
}

function secret(
  env: Environment,
  issues: ConfigurationIssue[],
  name: string,
  minimumLength = 1,
): string {
  const raw = required(env, issues, name);
  if (raw && Buffer.byteLength(raw, "utf8") < minimumLength) {
    issues.push({
      field: name,
      message: `must be at least ${minimumLength} UTF-8 bytes`,
    });
  }
  if (raw && /[\u0000-\u001f\u007f]/.test(raw)) {
    issues.push({ field: name, message: "must not contain control characters" });
  }
  return raw;
}

function optionalPort(
  env: Environment,
  issues: ConfigurationIssue[],
  requiredInProduction = false,
): void {
  if (requiredInProduction && !present(env, "PORT")) {
    issues.push({ field: "PORT", message: "is required in production" });
    return;
  }
  if (!present(env, "PORT")) return;
  const port = value(env, "PORT");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    issues.push({ field: "PORT", message: "must be an integer from 1 to 65535" });
  } else if (requiredInProduction && Number(port) !== PRODUCTION_PORT) {
    issues.push({
      field: "PORT",
      message: `must be ${PRODUCTION_PORT} to match the production reverse proxy`,
    });
  }
}

function optionalRateLimitMode(
  env: Environment,
  issues: ConfigurationIssue[],
  production: boolean,
): void {
  if (production && !present(env, "RATE_LIMIT_MODE")) {
    issues.push({ field: "RATE_LIMIT_MODE", message: "is required in production" });
    return;
  }
  if (!present(env, "RATE_LIMIT_MODE")) return;
  const mode = value(env, "RATE_LIMIT_MODE");
  const allowed = production ? ["enforce"] : ["enforce", "observe"];
  if (!allowed.includes(mode)) {
    issues.push({
      field: "RATE_LIMIT_MODE",
      message: production ? "must be enforce in production" : "must be enforce or observe",
    });
  }
}

/** Derive the raw base64url Ed25519 public key published by the service. */
export function signingPublicKeyFromSeed(seed: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(seed)) return null;
  try {
    const der = Buffer.concat([
      Buffer.from(PKCS8_ED25519_PREFIX, "hex"),
      Buffer.from(seed, "hex"),
    ]);
    const privateKey = createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const jwk = createPublicKey(pem).export({ format: "jwk" }) as unknown as {
      x?: string;
    };
    return typeof jwk.x === "string" && jwk.x ? jwk.x : null;
  } catch {
    return null;
  }
}

/**
 * Read-only standalone-service preflight.
 *
 * It intentionally does not create the archive directory or a write probe.
 * The archive lease and the app's durability readiness probe perform those
 * mutating checks after this schema has passed. Requiring an existing,
 * accessible directory here also prevents a typo from silently creating a new
 * empty archive somewhere else.
 */
export function preflightProductionConfig(
  env: Environment = process.env,
  registry: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): ProductionConfigPreflight {
  const issues: ConfigurationIssue[] = [];
  const nodeEnvironment = value(env, "NODE_ENV");
  const bypass = value(env, "DEV_SKIP_PAYMENT") === "1";
  const mode = bypass ? "local_bypass" : "production";

  if (LOCAL_BYPASS_ENVIRONMENTS.has(nodeEnvironment)) {
    if (!bypass) {
      issues.push({
        field: "DEV_SKIP_PAYMENT",
        message:
          "must be 1 for the standalone server in development or test; paid standalone starts require NODE_ENV=production",
      });
    }
    optionalPort(env, issues);
    optionalRateLimitMode(env, issues, false);
    return issues.length ? { ok: false, mode, issues } : { ok: true, mode };
  }
  if (bypass) {
    issues.push({
      field: "DEV_SKIP_PAYMENT",
      message:
        "may be enabled only when NODE_ENV is explicitly development or test",
    });
    return { ok: false, mode, issues };
  }

  if (nodeEnvironment !== "production") {
    issues.push({
      field: "NODE_ENV",
      message:
        "must be production for the paid standalone server (use explicit development/test with DEV_SKIP_PAYMENT=1 locally)",
    });
  }
  if (present(env, "DEV_SKIP_PAYMENT") && value(env, "DEV_SKIP_PAYMENT") !== "0") {
    issues.push({
      field: "DEV_SKIP_PAYMENT",
      message: "must be unset or 0 in production",
    });
  }

  const origin = required(env, issues, "PUBLIC_ORIGIN");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:") {
        issues.push({ field: "PUBLIC_ORIGIN", message: "must use HTTPS" });
      }
      if (origin !== PRODUCTION_PUBLIC_ORIGIN) {
        issues.push({
          field: "PUBLIC_ORIGIN",
          message: `must be ${PRODUCTION_PUBLIC_ORIGIN}`,
        });
      }
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== "/" && url.pathname !== "")
      ) {
        issues.push({
          field: "PUBLIC_ORIGIN",
          message: "must be an origin only, without credentials, path, query, or fragment",
        });
      }
    } catch {
      issues.push({ field: "PUBLIC_ORIGIN", message: "must be a valid URL" });
    }
  }

  const network = required(env, issues, "X402_NETWORK");
  if (
    network &&
    !(SUPPORTED_PAYMENT_NETWORKS as readonly string[]).includes(network)
  ) {
    issues.push({
      field: "X402_NETWORK",
      message: `must be one of: ${SUPPORTED_PAYMENT_NETWORKS.join(", ")}`,
    });
  }
  const price = required(env, issues, "DOSSIER_PRICE");
  if (
    price &&
    (!/^\$(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(price) ||
      Number(price.slice(1)) <= 0)
  ) {
    issues.push({
      field: "DOSSIER_PRICE",
      message: "must be a positive USD amount such as $0.01",
    });
  }

  const payTo = required(env, issues, "PAY_TO");
  if (
    payTo &&
    (!/^0x[0-9a-f]{40}$/i.test(payTo) || /^0x0{40}$/i.test(payTo))
  ) {
    issues.push({
      field: "PAY_TO",
      message: "must be a non-zero 20-byte EVM address",
    });
  }
  if (price && price !== PRODUCTION_PRICE) {
    issues.push({
      field: "DOSSIER_PRICE",
      message: `must be ${PRODUCTION_PRICE} to match the published listing`,
    });
  }
  if (payTo && payTo.toLowerCase() !== PRODUCTION_PAY_TO.toLowerCase()) {
    issues.push({
      field: "PAY_TO",
      message: "must match the registered production payout wallet",
    });
  }

  const apiKey = secret(env, issues, "OKX_API_KEY");
  const secretKey = secret(env, issues, "OKX_SECRET_KEY");
  const passphrase = secret(env, issues, "OKX_PASSPHRASE");
  const internalKey = secret(env, issues, "INTERNAL_KEY", 32);
  const archiveMacKey = secret(env, issues, "ARCHIVE_MAC_KEY", 32);
  const replayKey = secret(env, issues, "PAYMENT_REPLAY_KEY", 32);

  if (value(env, "ARCHIVE_MAC_REQUIRED") !== "1") {
    issues.push({
      field: "ARCHIVE_MAC_REQUIRED",
      message: "must be 1 for authenticated production recovery records",
    });
  }

  const signingKey = required(env, issues, "SIGNING_KEY");
  const derivedPublicKey = signingPublicKeyFromSeed(signingKey);
  if (signingKey && !derivedPublicKey) {
    issues.push({
      field: "SIGNING_KEY",
      message: "must be a valid 32-byte Ed25519 seed encoded as 64 hex characters",
    });
  }
  const pinnedPublicKey = required(
    env,
    issues,
    "DOSSIER_SIGNING_PUBLIC_KEY",
  );
  if (
    pinnedPublicKey &&
    (!/^[A-Za-z0-9_-]{43}$/.test(pinnedPublicKey) ||
      Buffer.from(pinnedPublicKey, "base64url").length !== 32)
  ) {
    issues.push({
      field: "DOSSIER_SIGNING_PUBLIC_KEY",
      message: "must be a 32-byte Ed25519 public key encoded as base64url",
    });
  } else if (
    pinnedPublicKey &&
    derivedPublicKey &&
    pinnedPublicKey !== derivedPublicKey
  ) {
    issues.push({
      field: "DOSSIER_SIGNING_PUBLIC_KEY",
      message: "does not correspond to SIGNING_KEY",
    });
  }
  if (
    derivedPublicKey &&
    !activeTrustedSigningKey(derivedPublicKey, registry, {
      schemaVersion: SCHEMA_VERSION,
      methodologyVersion: METHODOLOGY_VERSION,
    })
  ) {
    issues.push({
      field: "SIGNING_KEY",
      message:
        "derives a public key that is not currently active for this schema and methodology in the code-reviewed Dossier trust registry",
    });
  }

  // The legacy MAC is an offline migration input, never a runtime credential.
  // Refuse it here rather than accidentally allowing a future archive read path
  // to make historical material part of current ownership decisions.
  if (value(env, "ARCHIVE_LEGACY_MAC_KEY")) {
    issues.push({
      field: "ARCHIVE_LEGACY_MAC_KEY",
      message: "is migration-only and must not be present in the running service environment",
    });
  }

  // These values protect different trust boundaries. Reusing one secret means
  // compromising the least privileged consumer also compromises all the rest.
  const independentSecrets = [
    ["OKX_API_KEY", apiKey],
    ["OKX_SECRET_KEY", secretKey],
    ["OKX_PASSPHRASE", passphrase],
    ["INTERNAL_KEY", internalKey],
    ["ARCHIVE_MAC_KEY", archiveMacKey],
    ["PAYMENT_REPLAY_KEY", replayKey],
    ["SIGNING_KEY", signingKey],
  ] as const;
  for (let i = 0; i < independentSecrets.length; i++) {
    const [name, candidate] = independentSecrets[i]!;
    if (!candidate) continue;
    const reused = independentSecrets
      .slice(0, i)
      .find(([, previous]) => previous && previous === candidate);
    if (reused) {
      issues.push({
        field: name,
        message: `must be independent from ${reused[0]}`,
      });
    }
  }

  const archiveDir = required(env, issues, "ARCHIVE_DIR");
  if (archiveDir) {
    if (!isAbsolute(archiveDir)) {
      issues.push({ field: "ARCHIVE_DIR", message: "must be an absolute path" });
    } else if (resolve(archiveDir) === "/") {
      issues.push({ field: "ARCHIVE_DIR", message: "must not be the filesystem root" });
    } else {
      try {
        if (lstatSync(archiveDir).isSymbolicLink()) {
          issues.push({ field: "ARCHIVE_DIR", message: "must not be a symbolic link" });
        } else if (!statSync(archiveDir).isDirectory()) {
          issues.push({ field: "ARCHIVE_DIR", message: "must name a directory" });
        } else if (resolve(realpathSync(archiveDir)) !== resolve(archiveDir)) {
          issues.push({
            field: "ARCHIVE_DIR",
            message: "must resolve directly without symbolic-link path components",
          });
        } else {
          const mode = statSync(archiveDir).mode & 0o777;
          if (mode !== 0o700) {
            issues.push({ field: "ARCHIVE_DIR", message: "must have mode 0700" });
          }
          accessSync(archiveDir, constants.R_OK | constants.W_OK | constants.X_OK);
        }
      } catch {
        issues.push({
          field: "ARCHIVE_DIR",
          message: "must already exist and be accessible to the service user",
        });
      }
    }
  }

  optionalPort(env, issues, true);
  optionalRateLimitMode(env, issues, true);

  return issues.length
    ? { ok: false, mode, issues }
    : {
        ok: true,
        mode,
        ...(derivedPublicKey ? { signingPublicKey: derivedPublicKey } : {}),
      };
}

export function assertProductionConfig(
  env: Environment = process.env,
  registry: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): ProductionConfigPreflight & { ok: true } {
  const result = preflightProductionConfig(env, registry);
  if (!result.ok) {
    const detail = result.issues
      .map((issue) => `${issue.field}: ${issue.message}`)
      .join("; ");
    throw new Error(`unsafe standalone configuration: ${detail}`);
  }
  return result;
}

// Payment-critical values come from env. The x402 challenge shape, asset, and
// on-chain verification are handled by the official OKX SDK. Defaults remain
// useful for app-only tests and free/demo imports; the standalone entry never
// accepts them in production because assertProductionConfig runs first.
export const config = {
  network: (process.env.X402_NETWORK ??
    SUPPORTED_PAYMENT_NETWORKS[0]) as `${string}:${string}`,
  dossierPrice: process.env.DOSSIER_PRICE ?? PRODUCTION_PRICE,
  payTo: (process.env.PAY_TO ?? "") as `0x${string}` | "",
  okx: {
    apiKey: process.env.OKX_API_KEY ?? "",
    secretKey: process.env.OKX_SECRET_KEY ?? "",
    passphrase: process.env.OKX_PASSPHRASE ?? "",
  },
  devSkipPayment: process.env.DEV_SKIP_PAYMENT === "1",
  internalKey: process.env.INTERNAL_KEY ?? "",
  publicOrigin: (process.env.PUBLIC_ORIGIN ?? PRODUCTION_PUBLIC_ORIGIN).replace(
    /\/+$/,
    "",
  ),
} as const;

export function paymentConfigured(): boolean {
  return Boolean(
    config.payTo &&
      config.okx.apiKey &&
      config.okx.secretKey &&
      config.okx.passphrase,
  );
}
