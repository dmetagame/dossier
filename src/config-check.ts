import { assertProductionConfig } from "./config";

const result = assertProductionConfig();
console.log(
  JSON.stringify({
    ok: true,
    mode: result.mode,
    signingPublicKey: result.signingPublicKey ?? null,
  }),
);
