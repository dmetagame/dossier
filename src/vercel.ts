import { handle } from "hono/vercel";
import { app } from "./app";

// This entry is retained only for free/demo serverless previews. Dossier's paid
// path requires one durable archive plus a standalone service lease; ephemeral
// multi-instance function filesystems cannot provide either invariant. Fail at
// module load before any paid route can advertise a challenge or accept money.
if (
  process.env.DEV_SKIP_PAYMENT !== "1" &&
  (process.env.PAY_TO ||
    process.env.OKX_API_KEY ||
    process.env.OKX_SECRET_KEY ||
    process.env.OKX_PASSPHRASE)
) {
  throw new Error(
    "paid Dossier cannot run in the Vercel function entry; deploy src/server.ts on durable standalone storage",
  );
}

// Vercel's Node functions runtime dispatches on named method exports with the
// web (Request -> Response) signature; a default export's return value is ignored.
const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
