/**
 * Stamp the Worker D1 binding, then ensure the schema before routes / pages.
 * Runs on every request (`src/middleware/` = Void global middleware, in
 * numeric order after the timeout and pod-host gates). Also stamps the
 * runner credentials for the plain-route fetch path (what `handleHttp` did
 * before the Void routes slice).
 */

import type { D1Database } from "@cloudflare/workers-types";
import { defineMiddleware } from "void";

import { ensureDbPromise, setD1Binding } from "../lib/db";
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
  // setup pass. Register the pass with the worker lifetime: celld drops a
  // request's pending work when that request answers or its client leaves,
  // and an unregistered pass would hang every waiter on a cold isolate to
  // the full 5 s wait (issues #91, #92, flake H).
  await ensureDbPromise({ ctx: c.executionCtx });

  return next();
});
