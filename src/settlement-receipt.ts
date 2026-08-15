import { z } from "zod";

/** Values the server already knows from the payment requirement it issued. */
export interface ExpectedSettlement {
  /** The scheme determines whether the facilitator must report the amount. */
  scheme?: string;
  network: string;
  /**
   * The atomic amount requested from the facilitator. Exact settlement
   * responses commonly omit `amount` because the requested amount is fixed;
   * variable-amount schemes (such as `upto`) must report the actual amount.
   * Whenever a receipt does include an amount, it must still match exactly.
   */
  amount?: string;
  /** Successful verification's payer, retained when a receipt omits it. */
  payer?: string;
}

export interface ConfirmedSettlementReceipt {
  success: true;
  status?: "success";
  transaction: string;
  network: string;
  amount?: string;
  payer?: string;
}

/** Bounded direct settle fields captured before the SDK performs polling. */
export interface DirectSettlementAnswer {
  success?: boolean;
  status?: string;
  transaction?: string;
  network?: string;
  amount?: string;
  payer?: string;
}

/** Bounded fields observed from the last settle/status poll answer. */
export interface PolledSettlementAnswer extends DirectSettlementAnswer {
  status?: string;
}

export type SettlementReceiptFailure =
  | "missing"
  | "invalid_encoding"
  | "invalid_receipt"
  | "not_successful"
  | "not_final"
  | "network_mismatch"
  | "amount_mismatch";

export type SettlementReceiptResult =
  | { ok: true; receipt: ConfirmedSettlementReceipt }
  | { ok: false; reason: SettlementReceiptFailure };

// PAYMENT-RESPONSE is the SDK's base64-encoded SettleResponse. Keep this schema
// local: the SDK's decoder only casts parsed JSON to its TypeScript type, so it
// provides no runtime boundary for a response received over the network.
const receiptSchema = z
  .object({
    success: z.boolean(),
    status: z.enum(["pending", "success", "timeout"]).optional(),
    transaction: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    network: z.string().min(3),
    amount: z.string().nullable().optional(),
    payer: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Normalize the one contradictory header emitted by x402-core 0.1.0 after a
 * successful timeout poll. The direct settle answer must prove the exact
 * timeout path and every identity field observed in the direct answer, poll,
 * header, or server expectation must agree; a facilitator that directly
 * returned `{ success:false, status:"success" }` stays rejected.
 */
export function normalizeTimeoutRecoveryReceipt(
  header: string | null | undefined,
  direct: DirectSettlementAnswer | undefined,
  polled?: PolledSettlementAnswer,
  expected?: ExpectedSettlement,
): string | null | undefined {
  if (
    !header ||
    direct?.success !== false ||
    direct.status !== "timeout" ||
    !direct.transaction ||
    !direct.network ||
    polled?.success !== true ||
    polled.status !== "success" ||
    !polled.transaction ||
    !polled.network ||
    polled.transaction.toLowerCase() !== direct.transaction.toLowerCase() ||
    polled.network !== direct.network ||
    (expected?.network !== undefined &&
      (direct.network !== expected.network || polled.network !== expected.network)) ||
    (direct.amount !== undefined && polled.amount !== direct.amount) ||
    (expected?.amount !== undefined &&
      ((direct.amount !== undefined && direct.amount !== expected.amount) ||
        (polled.amount !== undefined && polled.amount !== expected.amount))) ||
    (direct.payer !== undefined && polled.payer?.toLowerCase() !== direct.payer.toLowerCase()) ||
    (expected?.payer !== undefined &&
      ((direct.payer !== undefined &&
        direct.payer.toLowerCase() !== expected.payer.toLowerCase()) ||
        (polled.payer !== undefined &&
          polled.payer.toLowerCase() !== expected.payer.toLowerCase())))
  ) {
    return header;
  }

  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (
      !decoded ||
      typeof decoded !== "object" ||
      (decoded as any).success !== false ||
      (decoded as any).status !== "success" ||
      String((decoded as any).transaction).toLowerCase() !== direct.transaction.toLowerCase() ||
      (decoded as any).network !== direct.network ||
      (polled.amount !== undefined &&
        (decoded as any).amount != null &&
        (decoded as any).amount !== polled.amount) ||
      (direct.amount !== undefined &&
        (decoded as any).amount != null &&
        (decoded as any).amount !== direct.amount) ||
      (expected?.amount !== undefined &&
        (decoded as any).amount != null &&
        (decoded as any).amount !== expected.amount) ||
      (polled.payer !== undefined &&
        (decoded as any).payer != null &&
        (typeof (decoded as any).payer !== "string" ||
          (decoded as any).payer.toLowerCase() !== polled.payer.toLowerCase())) ||
      (direct.payer !== undefined &&
        (decoded as any).payer != null &&
        (typeof (decoded as any).payer !== "string" ||
          (decoded as any).payer.toLowerCase() !== direct.payer.toLowerCase())) ||
      (expected?.payer !== undefined &&
        (decoded as any).payer != null &&
        (typeof (decoded as any).payer !== "string" ||
          (decoded as any).payer.toLowerCase() !== expected.payer.toLowerCase()))
    ) {
      return header;
    }
    return Buffer.from(
      JSON.stringify({ ...(decoded as Record<string, unknown>), success: true }),
      "utf8",
    ).toString("base64");
  } catch {
    return header;
  }
}

/**
 * Decode and validate a PAYMENT-RESPONSE header as a confirmed settlement.
 *
 * `pending` and `timeout` are deliberately not confirmations. A legacy receipt
 * with no status is accepted only when its `success` flag is true; a modern OKX
 * synchronous receipt must say `status: "success"`.
 */
export function validateSettlementReceipt(
  header: string | null | undefined,
  expected: ExpectedSettlement,
): SettlementReceiptResult {
  if (!header) return { ok: false, reason: "missing" };

  // The SDK emits standard padded base64. Buffer.from() is intentionally
  // forgiving, so reject characters and impossible lengths before decoding.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(header) || header.length % 4 !== 0) {
    return { ok: false, reason: "invalid_encoding" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_encoding" };
  }

  const parsed = receiptSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: "invalid_receipt" };

  const receipt = parsed.data;
  if (receipt.success !== true) return { ok: false, reason: "not_successful" };
  if (receipt.status !== undefined && receipt.status !== "success") {
    return { ok: false, reason: "not_final" };
  }
  if (receipt.network !== expected.network) {
    return { ok: false, reason: "network_mismatch" };
  }
  if (
    receipt.payer != null &&
    !/^0x[0-9a-fA-F]{40}$/.test(receipt.payer)
  ) {
    return { ok: false, reason: "invalid_receipt" };
  }
  if (
    expected.payer !== undefined &&
    receipt.payer != null &&
    receipt.payer.toLowerCase() !== expected.payer.toLowerCase()
  ) {
    return { ok: false, reason: "invalid_receipt" };
  }
  if (
    expected.amount !== undefined &&
    receipt.amount != null &&
    receipt.amount !== expected.amount
  ) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (
    expected.amount !== undefined &&
    expected.scheme !== undefined &&
    expected.scheme !== "exact" &&
    receipt.amount == null
  ) {
    return { ok: false, reason: "amount_mismatch" };
  }

  const amount =
    receipt.amount != null
      ? receipt.amount
      : expected.scheme === "exact"
        ? expected.amount
        : undefined;
  const payer = receipt.payer ?? expected.payer;

  return {
    ok: true,
    receipt: {
      success: true,
      ...(receipt.status === "success" ? { status: receipt.status } : {}),
      transaction: receipt.transaction,
      network: receipt.network,
      ...(amount !== undefined ? { amount } : {}),
      ...(payer !== undefined ? { payer } : {}),
    },
  };
}
