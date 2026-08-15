import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTimeoutRecoveryReceipt,
  validateSettlementReceipt,
} from "../src/settlement-receipt";

const NETWORK = "eip155:196";
const TX = "0x" + "12".repeat(32);

function header(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("PAYMENT-RESPONSE settlement validator", () => {
  test("accepts a final modern receipt", () => {
    const result = validateSettlementReceipt(
      header({
        success: true,
        status: "success",
        transaction: TX,
        network: NETWORK,
        amount: "10000",
        payer: "0x00000000000000000000000000000000000000ff",
        extensions: { ignored: "not returned" },
      }),
      { scheme: "exact", network: NETWORK, amount: "10000" },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.receipt.transaction, TX);
      assert.equal(result.receipt.amount, "10000");
      assert.equal("extensions" in result.receipt, false, "do not expose extension data");
    }
  });

  test("accepts a successful legacy receipt with no status", () => {
    const result = validateSettlementReceipt(
      header({ success: true, transaction: TX, network: NETWORK }),
      { network: NETWORK },
    );
    assert.equal(result.ok, true);
  });

  for (const [name, receipt] of [
    ["failed", { success: false, transaction: TX, network: NETWORK }],
    ["pending", { success: true, status: "pending", transaction: TX, network: NETWORK }],
    ["timeout", { success: true, status: "timeout", transaction: TX, network: NETWORK }],
    ["contradictory final", { success: false, status: "success", transaction: TX, network: NETWORK }],
  ] as const) {
    test(`rejects ${name} receipts even when they carry a hash`, () => {
      const result = validateSettlementReceipt(header(receipt), { network: NETWORK });
      assert.equal(result.ok, false);
    });
  }

  test("requires a canonical 32-byte EVM transaction hash", () => {
    for (const tx of ["0xabc", "0x" + "gg".repeat(32), "0x" + "11".repeat(31)]) {
      const result = validateSettlementReceipt(
        header({ success: true, status: "success", transaction: tx, network: NETWORK }),
        { network: NETWORK },
      );
      assert.equal(result.ok, false, tx);
    }
  });

  test("requires the expected network and rejects any conflicting amount", () => {
    const wrongNetwork = validateSettlementReceipt(
      header({ success: true, status: "success", transaction: TX, network: "eip155:1" }),
      { network: NETWORK },
    );
    assert.deepEqual(wrongNetwork, { ok: false, reason: "network_mismatch" });

    const wrongAmount = validateSettlementReceipt(
      header({ success: true, status: "success", transaction: TX, network: NETWORK, amount: "1" }),
      { scheme: "exact", network: NETWORK, amount: "10000" },
    );
    assert.deepEqual(wrongAmount, { ok: false, reason: "amount_mismatch" });

    const exactWithoutAmount = validateSettlementReceipt(
      header({ success: true, status: "success", transaction: TX, network: NETWORK }),
      { scheme: "exact", network: NETWORK, amount: "10000" },
    );
    assert.equal(
      exactWithoutAmount.ok,
      true,
      "exact receipts omit amount because the settlement request already fixes it",
    );
    if (exactWithoutAmount.ok) {
      assert.equal(
        exactWithoutAmount.receipt.amount,
        "10000",
        "the normalized proof retains the exact amount from the signed requirement",
      );
    }

    const variableWithoutAmount = validateSettlementReceipt(
      header({ success: true, status: "success", transaction: TX, network: NETWORK }),
      { scheme: "upto", network: NETWORK, amount: "10000" },
    );
    assert.deepEqual(variableWithoutAmount, { ok: false, reason: "amount_mismatch" });
  });

  test("rejects malformed base64 and JSON", () => {
    assert.deepEqual(
      validateSettlementReceipt("not-base64!!", { network: NETWORK }),
      { ok: false, reason: "invalid_encoding" },
    );
    assert.deepEqual(
      validateSettlementReceipt(Buffer.from("{oops", "utf8").toString("base64"), { network: NETWORK }),
      { ok: false, reason: "invalid_encoding" },
    );
  });

  test("normalizes a successful timeout poll when optional receipt fields are null", () => {
    const payer = "0x00000000000000000000000000000000000000ff";
    const normalized = normalizeTimeoutRecoveryReceipt(
      header({
        success: false,
        status: "success",
        transaction: TX,
        network: NETWORK,
        amount: null,
        payer: null,
      }),
      {
        success: false,
        status: "timeout",
        transaction: TX,
        network: NETWORK,
      },
      {
        success: true,
        status: "success",
        transaction: TX,
        network: NETWORK,
        payer,
      },
      { scheme: "exact", network: NETWORK, amount: "10000", payer },
    );
    const result = validateSettlementReceipt(normalized, {
      scheme: "exact",
      network: NETWORK,
      amount: "10000",
      payer,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.receipt.status, "success");
      assert.equal(result.receipt.amount, "10000");
      assert.equal(result.receipt.payer, payer);
    }
  });

  test("normalizes only the SDK's successful timeout-poll header bug", () => {
    const contradictory = header({
      success: false,
      status: "success",
      transaction: TX,
      network: NETWORK,
      payer: "0x00000000000000000000000000000000000000ff",
    });
    const normalized = normalizeTimeoutRecoveryReceipt(contradictory, {
      success: false,
      status: "timeout",
      transaction: TX,
      network: NETWORK,
      payer: "0x00000000000000000000000000000000000000ff",
    }, {
      success: true,
      status: "success",
      transaction: TX,
      network: NETWORK,
      payer: "0x00000000000000000000000000000000000000ff",
    });
    assert.equal(
      validateSettlementReceipt(normalized, { network: NETWORK }).ok,
      true,
      "a final 2xx after the SDK polled a direct timeout is confirmed",
    );

    assert.equal(
      normalizeTimeoutRecoveryReceipt(contradictory, {
        success: false,
        status: "success",
        transaction: TX,
        network: NETWORK,
      }, {
        success: true,
        status: "success",
        transaction: TX,
        network: NETWORK,
      }),
      contradictory,
      "a directly contradictory facilitator answer is not normalized",
    );
    assert.equal(
      normalizeTimeoutRecoveryReceipt(contradictory, {
        success: false,
        status: "timeout",
        transaction: "0x" + "34".repeat(32),
        network: NETWORK,
      }, {
        success: true,
        status: "success",
        transaction: TX,
        network: NETWORK,
      }),
      contradictory,
      "the direct answer and final header must identify the same transaction",
    );

    assert.equal(
      normalizeTimeoutRecoveryReceipt(
        contradictory,
        {
          success: false,
          status: "timeout",
          transaction: TX,
          network: NETWORK,
        },
        {
          success: true,
          status: "success",
          transaction: "0x" + "56".repeat(32),
          network: NETWORK,
        },
      ),
      contradictory,
      "a successful poll for another transaction cannot repair the receipt",
    );

    const amountHeader = header({
      success: false,
      status: "success",
      transaction: TX,
      network: NETWORK,
      amount: "10000",
    });
    assert.equal(
      normalizeTimeoutRecoveryReceipt(
        amountHeader,
        {
          success: false,
          status: "timeout",
          transaction: TX.toUpperCase().replace("0X", "0x"),
          network: NETWORK,
          amount: "10000",
        },
        {
          success: true,
          status: "success",
          transaction: TX,
          network: NETWORK,
          amount: "1",
        },
      ),
      amountHeader,
      "a poll with a different amount cannot repair the receipt",
    );
    assert.notEqual(
      normalizeTimeoutRecoveryReceipt(
        amountHeader,
        {
          success: false,
          status: "timeout",
          transaction: TX.toUpperCase().replace("0X", "0x"),
          network: NETWORK,
          amount: "10000",
        },
        {
          success: true,
          status: "success",
          transaction: TX,
          network: NETWORK,
          amount: "10000",
        },
      ),
      amountHeader,
      "EVM transaction case alone does not make matching receipts contradictory",
    );

    const mixedCasePayer = "0x00000000000000000000000000000000000000Aa";
    const payerHeader = header({
      success: false,
      status: "success",
      transaction: TX,
      network: NETWORK,
      payer: mixedCasePayer,
    });
    const payerNormalized = normalizeTimeoutRecoveryReceipt(
      payerHeader,
      {
        success: false,
        status: "timeout",
        transaction: TX,
        network: NETWORK,
        payer: mixedCasePayer.toLowerCase(),
      },
      {
        success: true,
        status: "success",
        transaction: TX,
        network: NETWORK,
        payer: mixedCasePayer.toUpperCase().replace("0X", "0x"),
      },
    );
    assert.notEqual(
      payerNormalized,
      payerHeader,
      "EVM payer checksum case alone does not invalidate timeout recovery",
    );
    assert.equal(
      validateSettlementReceipt(payerNormalized, {
        network: NETWORK,
        payer: mixedCasePayer.toLowerCase(),
      }).ok,
      true,
    );

    const pollPayerMismatch = normalizeTimeoutRecoveryReceipt(
      payerHeader,
      {
        success: false,
        status: "timeout",
        transaction: TX,
        network: NETWORK,
      },
      {
        success: true,
        status: "success",
        transaction: TX,
        network: NETWORK,
        payer: "0x00000000000000000000000000000000000000bb",
      },
      { network: NETWORK, payer: mixedCasePayer },
    );
    assert.equal(
      pollPayerMismatch,
      payerHeader,
      "a successful poll cannot repair a header that names another payer",
    );

    const pollAmountMismatch = normalizeTimeoutRecoveryReceipt(
      amountHeader,
      {
        success: false,
        status: "timeout",
        transaction: TX,
        network: NETWORK,
      },
      {
        success: true,
        status: "success",
        transaction: TX,
        network: NETWORK,
        amount: "1",
      },
      { scheme: "exact", network: NETWORK, amount: "10000" },
    );
    assert.equal(
      pollAmountMismatch,
      amountHeader,
      "a successful poll cannot repair a header that contradicts its amount evidence",
    );
  });

  test("retains trusted optional fields when omitted or null and rejects a contradiction", () => {
    const payer = "0x00000000000000000000000000000000000000ff";
    for (const optional of [{}, { amount: null, payer: null }]) {
      const result = validateSettlementReceipt(
        header({
          success: true,
          status: "success",
          transaction: TX,
          network: NETWORK,
          ...optional,
        }),
        { scheme: "exact", network: NETWORK, amount: "10000", payer },
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.receipt.amount, "10000");
        assert.equal(result.receipt.payer, payer);
      }
    }

    assert.equal(
      validateSettlementReceipt(
        header({
          success: true,
          status: "success",
          transaction: TX,
          network: NETWORK,
          payer,
        }),
        { network: NETWORK, payer },
      ).ok,
      true,
    );
    assert.equal(
      validateSettlementReceipt(
        header({
          success: true,
          status: "success",
          transaction: TX,
          network: NETWORK,
          payer: "0x0000000000000000000000000000000000000011",
        }),
        { network: NETWORK, payer },
      ).ok,
      false,
    );
  });
});
