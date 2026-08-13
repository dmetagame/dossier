import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface ConfirmedSettlement {
  status: "confirmed";
  transaction: string;
  network: string;
  amount?: string;
  payer?: string;
}

export interface ArchiveRecord {
  id: string;
  paramsSha256: string;
  resolvedParamsSha256?: string;
  mac?: string;
  request: Record<string, unknown>;
  contentType: string;
  deliverable: string;
  deliveredAt: string;
  paymentTransaction?: string;
  settlement?: ConfirmedSettlement;
  jobId?: string;
  recoveryCodeSha256?: string;
}

export interface TransactionClaim {
  v: 1;
  transaction: string;
  recordId: string;
  recordDigest: string;
  settlement?: ConfirmedSettlement;
  mac?: string;
}

export const RECORD_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
export const LOWER_SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Stable recursive JSON encoding used by every current Dossier HMAC. */
export function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`);
  return `{${entries.join(",")}}`;
}

/** Internal sidecar key. Callers must validate the exact transaction first. */
export function transactionKey(transaction: string): string {
  if (!validTransactionHash(transaction)) {
    throw new Error("transaction must be an exact 32-byte on-chain hash");
  }
  return createHash("sha256").update(transaction.toLowerCase()).digest("hex");
}

export function validTransactionHash(transaction: unknown): transaction is string {
  return typeof transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction);
}

export function validConfirmedSettlement(
  value: unknown,
  transaction?: string,
): value is ConfirmedSettlement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settlement = value as Record<string, unknown>;
  return (
    settlement.status === "confirmed" &&
    typeof settlement.transaction === "string" &&
    validTransactionHash(settlement.transaction) &&
    (transaction === undefined ||
      settlement.transaction.toLowerCase() === transaction.toLowerCase()) &&
    typeof settlement.network === "string" &&
    settlement.network !== "" &&
    (settlement.amount === undefined || typeof settlement.amount === "string") &&
    (settlement.payer === undefined ||
      (typeof settlement.payer === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(settlement.payer)))
  );
}

export function settlementSame(
  a: ConfirmedSettlement | undefined,
  b: ConfirmedSettlement | undefined,
): boolean {
  return (
    (a === undefined || validConfirmedSettlement(a)) &&
    (b === undefined || validConfirmedSettlement(b)) &&
    a?.status === b?.status &&
    a?.transaction?.toLowerCase() === b?.transaction?.toLowerCase() &&
    a?.network === b?.network &&
    (a?.amount ?? undefined) === (b?.amount ?? undefined) &&
    (a?.payer?.toLowerCase() ?? undefined) === (b?.payer?.toLowerCase() ?? undefined)
  );
}

export function archiveMacKey(secret: string | undefined): Buffer | null {
  return secret
    ? createHash("sha256").update(`dossier-archive-mac:${secret}`).digest()
    : null;
}

export function archiveKeyFingerprint(secret: string | undefined): string | null {
  const key = archiveMacKey(secret);
  return key
    ? createHash("sha256")
        .update("dossier-archive-key-fingerprint:")
        .update(key)
        .digest("hex")
    : null;
}

export function archiveRecordMac(
  record: ArchiveRecord,
  secret: string | undefined,
): string | null {
  const key = archiveMacKey(secret);
  if (!key) return null;
  const covered = canonicalValue({
    id: record.id,
    paramsSha256: record.paramsSha256,
    resolvedParamsSha256: record.resolvedParamsSha256,
    request: record.request,
    contentType: record.contentType,
    deliverableSha256: createHash("sha256").update(record.deliverable).digest("hex"),
    deliveredAt: record.deliveredAt,
    jobId: record.jobId,
    paymentTransaction: record.paymentTransaction,
    settlement: record.settlement,
    recoveryCodeSha256: record.recoveryCodeSha256,
  });
  return createHmac("sha256", key).update(covered).digest("hex");
}

export function archiveRecordMacValid(
  record: ArchiveRecord,
  secret: string | undefined,
  requireMac: boolean,
): boolean {
  const key = archiveMacKey(secret);
  if (!key) return !requireMac;
  if (!record.mac) return !requireMac;
  if (!SHA256_PATTERN.test(record.mac)) return false;
  const expected = archiveRecordMac(record, secret);
  return expected !== null && safeHexEqual(expected, record.mac);
}

/** Digest used by a transaction claim; mutable settlement/recovery fields stay out. */
export function archiveRecordDigest(record: ArchiveRecord): string {
  return createHash("sha256")
    .update(
      canonicalValue({
        id: record.id,
        paramsSha256: record.paramsSha256,
        resolvedParamsSha256: record.resolvedParamsSha256,
        request: record.request,
        contentType: record.contentType,
        deliverableSha256: createHash("sha256").update(record.deliverable).digest("hex"),
        deliveredAt: record.deliveredAt,
        jobId: record.jobId,
      }),
    )
    .digest("hex");
}

export function transactionClaimMac(
  claim: Omit<TransactionClaim, "mac">,
  secret: string | undefined,
): string | null {
  const key = archiveMacKey(secret);
  return key
    ? createHmac("sha256", key).update(canonicalValue(claim)).digest("hex")
    : null;
}

export function transactionClaimShapeValid(value: unknown): value is TransactionClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Partial<TransactionClaim>;
  return (
    claim.v === 1 &&
    validTransactionHash(claim.transaction) &&
    typeof claim.recordId === "string" &&
    RECORD_ID_PATTERN.test(claim.recordId) &&
    typeof claim.recordDigest === "string" &&
    SHA256_PATTERN.test(claim.recordDigest) &&
    (claim.settlement === undefined ||
      validConfirmedSettlement(claim.settlement, claim.transaction)) &&
    (claim.mac === undefined ||
      (typeof claim.mac === "string" && SHA256_PATTERN.test(claim.mac)))
  );
}

export function transactionClaimValid(
  value: unknown,
  secret: string | undefined,
  requireMac: boolean,
): value is TransactionClaim {
  if (!transactionClaimShapeValid(value)) return false;
  const key = archiveMacKey(secret);
  if (!key) return !requireMac;
  if (!value.mac || !SHA256_PATTERN.test(value.mac)) return false;
  const { mac: _mac, ...unsigned } = value;
  const expected = transactionClaimMac(unsigned, secret);
  return expected !== null && safeHexEqual(expected, value.mac);
}

export function mergedClaimRecord(
  record: ArchiveRecord,
  claim: TransactionClaim,
): ArchiveRecord | null {
  if (!transactionClaimShapeValid(claim)) return null;
  if (archiveRecordDigest(record) !== claim.recordDigest) return null;
  const currentTransaction = record.settlement?.transaction || record.paymentTransaction;
  if (
    currentTransaction &&
    currentTransaction.toLowerCase() !== claim.transaction.toLowerCase()
  ) {
    return null;
  }
  if (
    record.settlement &&
    claim.settlement &&
    !settlementSame(record.settlement, claim.settlement)
  ) {
    return null;
  }
  return {
    ...record,
    paymentTransaction: claim.transaction,
    ...(claim.settlement ? { settlement: claim.settlement } : {}),
  };
}

function safeHexEqual(expected: string, actual: string): boolean {
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(actual, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * The pre-settlement-integrity build used a shallower MAC and could fall back to
 * SIGNING_KEY. Migration may verify it only when the operator supplies that
 * exact historical secret explicitly.
 */
export function legacyArchiveRecordMac(
  record: ArchiveRecord,
  legacySecret: string | undefined,
): string | null {
  const key = archiveMacKey(legacySecret);
  if (!key) return null;
  const covered: Record<string, unknown> = {
    id: record.id,
    paramsSha256: record.paramsSha256,
    resolvedParamsSha256: record.resolvedParamsSha256,
    contentType: record.contentType,
    deliverableSha256: createHash("sha256").update(record.deliverable).digest("hex"),
    deliveredAt: record.deliveredAt,
    jobId: record.jobId,
    paymentTransaction: record.paymentTransaction,
    recoveryCodeSha256: record.recoveryCodeSha256,
  };
  const entries = Object.entries(covered)
    .filter(([, item]) => item !== undefined && item !== null)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHmac("sha256", key).update(JSON.stringify(entries)).digest("hex");
}

export function legacyArchiveRecordMacV1(
  record: ArchiveRecord,
  legacySecret: string | undefined,
): string | null {
  const key = archiveMacKey(legacySecret);
  if (!key) return null;
  const covered: Record<string, unknown> = {
    id: record.id,
    paramsSha256: record.paramsSha256,
    resolvedParamsSha256: record.resolvedParamsSha256,
    contentType: record.contentType,
    deliverableSha256: createHash("sha256").update(record.deliverable).digest("hex"),
    deliveredAt: record.deliveredAt,
    jobId: record.jobId,
    paymentTransaction: record.paymentTransaction,
  };
  const entries = Object.entries(covered)
    .filter(([, item]) => item !== undefined && item !== null)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHmac("sha256", key).update(JSON.stringify(entries)).digest("hex");
}

export function legacyArchiveRecordMacValid(
  record: ArchiveRecord,
  legacySecret: string | undefined,
): boolean {
  if (!record.mac || !SHA256_PATTERN.test(record.mac)) return false;
  const expected = legacyArchiveRecordMac(record, legacySecret);
  const expectedV1 = legacyArchiveRecordMacV1(record, legacySecret);
  return (
    (expected !== null && safeHexEqual(expected, record.mac)) ||
    (expectedV1 !== null && safeHexEqual(expectedV1, record.mac))
  );
}
