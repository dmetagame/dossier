import { handle } from "hono/vercel";
import { app } from "./app";

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
