/**
 * Stamp the Worker D1 binding, then ensure the schema before routes / pages.
 * Runs on every request (`src/middleware/` = Void global middleware, in
 * numeric order after the timeout and pod-host gates). Also stamps the
 * runner credentials for the plain-route fetch path (what `handleHttp` did
 * before the Void routes slice).
 */

import type { D1Database } from "@cloudflare/workers-types";
import { defineMiddleware } from "void";

import { ensureDb, setD1Binding } from "../lib/db";
import { stampRunnerEnv } from "../lib/runner";

export default defineMiddleware(async (c, next) => {
  // SAFETY: c.env carries the control keys; the runner stamp only copies the two runner keys it knows.
  stampRunnerEnv(c.env as KitEnv);
  // SAFETY: DB is the D1 binding declared in void.config.ts; the middleware only stamps it when the platform injected a real binding.
  const d1 = c.env.DB as D1Database | undefined;

  if (d1) {
    setD1Binding(d1);
  }

  // Every request traverses this middleware — actions and `/assets/*` alike
  // (`run_worker_first: true`) — so every request shares the isolate's one
  // admin-bootstrap pass. Schema migrations are the runner's job (Void's
  // migration endpoint), never a request's.
  await ensureDb();

  return next();
});
