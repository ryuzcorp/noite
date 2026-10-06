import { CONTROL_BUILD } from "../../lib/control-app";
import type { RouteHandler } from "../config";

/** Deployment generation marker, stamped at build time (`vite.config.ts`
 * defines it from the git sha) so adoption is verifiable — `/health` exposes
 * it — without anyone remembering to bump a number. Without this, worker-code
 * version is indistinguishable from outside and every diagnosis branches.
 * (The marker itself lives in lib/control-app.ts so the control-app detail
 * page can show it too.) */
export const handleHealth: RouteHandler = () =>
  Response.json({ build: CONTROL_BUILD, ok: true, service: "noite-control" });
