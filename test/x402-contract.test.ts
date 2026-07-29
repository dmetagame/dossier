// Cold-agent discovery: what a buying agent can learn before it pays.
//
// This is the regression guard for the failure an external reviewer hit. Their
// client read the challenge, found no required inputs, paid 0.50 USD₮0, replayed
// without `tokenAddress`, and got a 400 for its money.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  dossierInputSchema,
  httpInputSchema,
  EXTENSIONS_BUDGET_BYTES,
} from "../src/x402-contract";
import { SUPPORTED_CHAINS } from "../src/engine/schema";
import { config } from "../src/config";

describe("the published input contract", () => {
  const ext = httpInputSchema(dossierInputSchema, "text/html", "the report");

  test("declares an HTTP input with a method and content type", () => {
    const input = (ext.outputSchema as any).input;
    assert.equal(input.type, "http");
    assert.equal(input.method, "POST");
    assert.equal(input.contentType, "application/json");
    assert.equal(input.bodyType, "json");
  });

  test("names tokenAddress as required", () => {
    const schema = (ext.outputSchema as any).input.schema;
    assert.deepEqual(schema.required, ["tokenAddress"]);
  });

  test("describes every parameter the route accepts", () => {
    const props = Object.keys((ext.outputSchema as any).input.schema.properties);
    assert.deepEqual(props.sort(), ["chain", "format", "tokenAddress"]);
  });

  test("constrains the address so a client can validate before paying", () => {
    const p = (ext.outputSchema as any).input.schema.properties.tokenAddress;
    assert.equal(p.type, "string");
    assert.ok(new RegExp(p.pattern).test("0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"));
    assert.equal(new RegExp(p.pattern).test("not-an-address"), false);
  });

  test("lists exactly the chains the engine supports", () => {
    const e = (ext.outputSchema as any).input.schema.properties.chain.enum;
    assert.deepEqual([...e].sort(), [...SUPPORTED_CHAINS].sort());
  });

  test("says what comes back, so the buyer knows what they bought", () => {
    const out = (ext.outputSchema as any).output;
    assert.equal(out.mimeType, "text/html");
    assert.ok(out.description.length > 0);
  });

  test("nothing here touches the accepts entries the client signs over", () => {
    // The contract is an `extensions` payload. If it ever grew a `scheme`,
    // `amount`, `asset` or `payTo` it would risk a facilitator mismatch.
    const json = JSON.stringify(ext);
    for (const forbidden of ["scheme", "payTo", "amount", "asset", "maxTimeoutSeconds"]) {
      assert.equal(json.includes(`"${forbidden}"`), false, `${forbidden} must not appear`);
    }
  });

  test("additional properties are refused, so typos surface as errors", () => {
    assert.equal(dossierInputSchema.additionalProperties, false);
  });
});

describe("the canonical resource URL", () => {
  test("is https, because a downgrade is a reason to refuse us", () => {
    // Behind a TLS-terminating proxy the request arrives as plain HTTP, so a
    // URL derived from it advertised http:// to buyers who reached us over TLS.
    assert.ok(
      config.publicOrigin.startsWith("https://"),
      `publicOrigin must be https, got ${config.publicOrigin}`,
    );
  });

  test("has no trailing slash, so route paths concatenate cleanly", () => {
    assert.equal(config.publicOrigin.endsWith("/"), false);
    // Exactly one "//" in the joined URL: the scheme separator, and no doubled
    // slash where the path begins.
    const joined = `${config.publicOrigin}/dossier`;
    assert.equal(joined.split("//").length - 1, 1, joined);
  });
});

// The challenge rides in a response *header*, so this schema is not free the way
// a body is. A proxy that caps headers turns an oversized challenge into a 502 on
// every 402 rather than truncating a field, so the paid route fails closed for
// everyone at once, with no warning as it approaches the limit.
describe("the challenge stays small enough to survive a proxy", () => {
  const extensions = httpInputSchema(
    dossierInputSchema,
    "text/html",
    "A rendered due-diligence report.",
  );
  const json = JSON.stringify(extensions);
  const onWire = Buffer.from(json, "utf8").toString("base64").length;

  test("extensions fit the budget", () => {
    assert.ok(
      json.length <= EXTENSIONS_BUDGET_BYTES,
      `extensions are ${json.length}B, over the ${EXTENSIONS_BUDGET_BYTES}B budget. ` +
        `Move detail into the 402 body, which has no ceiling, rather than raising this.`,
    );
  });

  test("base64 inflation is accounted for, not forgotten", () => {
    // Encoding costs a third on top. Budgeting the JSON and forgetting the
    // encoding is how a schema that looks safe arrives oversized.
    assert.ok(onWire >= json.length, "base64 never shrinks the payload");
    assert.ok(
      onWire <= 4096,
      `extensions alone reach ${onWire}B encoded, which leaves no room for the ` +
        `rest of the challenge under a 4KB proxy limit`,
    );
  });

  test("the descriptive prose has not crept into the header", () => {
    // Descriptions earn their place, but they are the part that grows without
    // anyone noticing. If they ever dominate, they belong in the body.
    const described = JSON.stringify(dossierInputSchema).match(/"description":"[^"]*"/g) ?? [];
    const prose = described.join("").length;
    assert.ok(
      prose < json.length * 0.75,
      `prose is ${prose}B of a ${json.length}B contract; move it to the 402 body`,
    );
  });
});
