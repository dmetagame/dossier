import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as reqlog from "../src/reqlog";

// The receipt shape as the OKX SDK emits it: base64 JSON on PAYMENT-RESPONSE.
function receipt(o: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(o), "utf8").toString("base64");
}

describe("request log", () => {
  test("a settled payment yields the transaction and the payer", () => {
    const r = reqlog.decodeReceipt(
      receipt({ transaction: "0xabc", payer: "0x51c2", network: "eip155:196" }),
    );
    assert.equal(r.settled, "0xabc");
    assert.equal(r.payer, "0x51c2");
  });

  test("a receipt that names the transaction differently is still read", () => {
    // The field has appeared as `transaction` and as `txHash` depending on the
    // path; missing the settlement because of a key name would defeat the point.
    assert.equal(reqlog.decodeReceipt(receipt({ txHash: "0xdef" })).settled, "0xdef");
    assert.equal(reqlog.decodeReceipt(receipt({ from: "0xf00" })).payer, "0xf00");
  });

  test("no receipt means no settlement claimed", () => {
    // This is the case that matters: a paid attempt that 4xx'd. The line must
    // not imply money moved, because it did not.
    assert.deepEqual(reqlog.decodeReceipt(null), {});
    assert.deepEqual(reqlog.decodeReceipt(undefined), {});
    assert.deepEqual(reqlog.decodeReceipt(""), {});
  });

  test("a corrupt receipt degrades to nothing rather than throwing", () => {
    assert.deepEqual(reqlog.decodeReceipt("not-base64-at-all!!"), {});
    assert.deepEqual(reqlog.decodeReceipt(Buffer.from("{oops").toString("base64")), {});
  });

  test("the payment authorisation is never carried into a line", () => {
    // PAYMENT-SIGNATURE is a bearer credential. decodeReceipt only ever reads
    // the response receipt, so even a receipt that echoes a signature back must
    // not surface it.
    const r = reqlog.decodeReceipt(
      receipt({ transaction: "0xabc", signature: "0xSECRET", authorization: "0xSECRET" }),
    );
    const dumped = JSON.stringify(r);
    assert.equal(dumped.includes("SECRET"), false, "no credential may reach the log");
    assert.deepEqual(Object.keys(r).sort(), ["settled"]);
  });

  test("static assets are treated as noise, real routes are not", () => {
    assert.equal(reqlog.isNoise("/f/Geist.woff2"), true);
    assert.equal(reqlog.isNoise("/favicon.ico"), true);
    for (const p of ["/dossier", "/health", "/info", "/dossier/preflight", "/"]) {
      assert.equal(reqlog.isNoise(p), false, `${p} must be logged`);
    }
  });

  test("a line is one greppable JSON object on one line", () => {
    const out = reqlog.format({ m: "POST", p: "/dossier", s: 200, ms: 42, paid: true });
    assert.equal(out.startsWith("[req] "), true);
    assert.equal(out.includes("\n"), false, "one request must be one line");
    const parsed = JSON.parse(out.slice("[req] ".length));
    assert.equal(parsed.p, "/dossier");
    assert.equal(parsed.paid, true);
  });

  test("the shape that proves a failed call charged nobody", () => {
    // paid, but no settlement: exactly what buyer 4844's 400 looked like, and
    // the question the log could not answer before this existed.
    const line = { m: "POST", p: "/dossier", s: 400, ms: 12, paid: true as const,
                   ...reqlog.decodeReceipt(null) };
    assert.equal(line.paid, true);
    assert.equal("settled" in line, false);
  });
});
