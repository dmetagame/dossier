import { serve } from "@hono/node-server";
import {
  acquireServiceLeaseForServer,
  releaseServiceLeaseAfterDrain,
} from "./dossier/archive";
import { assertProductionConfig } from "./config";

// The standalone entry is the paid deployment boundary. Validate it on every
// start, without an opt-in "strict" switch, before taking a lease or accepting
// traffic. App-only imports remain available to unit tests and free previews.
assertProductionConfig();
const port = Number(process.env.PORT ?? 8787);
// Take the migration startup interlock before importing the app or opening the
// listener. App initialization performs archive-backed readiness probes.
if (!acquireServiceLeaseForServer()) {
  throw new Error("archive service lease unavailable; an offline migration may be active");
}
let app: (typeof import("./app"))["app"];
try {
  ({ app } = await import("./app"));
} catch (error) {
  releaseServiceLeaseAfterDrain();
  throw error;
}
let listening = false;
let server: ReturnType<typeof serve>;
try {
  server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    listening = true;
    console.log(`verdict listening on :${info.port}`);
  });
} catch (error) {
  releaseServiceLeaseAfterDrain();
  throw error;
}
type DrainableServer = typeof server & {
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
};
const drainable = server as DrainableServer;
server.once("error", (error) => {
  if (!listening) {
    releaseServiceLeaseAfterDrain();
  }
  console.error("server error:", error);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => {
    drainable.closeAllConnections?.();
    const abort = setTimeout(() => process.exit(1), 2_000);
    abort.unref();
  }, 10_000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    releaseServiceLeaseAfterDrain();
    process.exit(0);
  });
  drainable.closeIdleConnections?.();
  console.log(`received ${signal}; draining requests`);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
