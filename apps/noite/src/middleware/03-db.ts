/**
 * Stamp the Worker D1 binding and every declared env key, then run the admin
 * bootstrap before routes / pages. Runs on every request that reaches the
 * Worker (`src/middleware/` = Void global middleware, in numeric order after
 * the timeout and the rate limit) — static bundles do not: celld serves
 * `/assets/*` itself, see `RUN_WORKER_FIRST` in `void.config.ts`. The full
 * stamp (not just the runner credentials) is what the plain-route fetch path
 * needs too (what `handleHttp` did before the Void routes slice): a partial
 * stamp left the setup gate reading dev defaults on deployed installs.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { defineMiddleware } from "void";

import { stampControlEnv } from "../lib/control-env";
import {
  DB_MIGRATING_BODY,
  DbUnavailableError,
  ensureDb,
  isMissingTableFailure,
  setD1Binding,
} from "../lib/db";

export default defineMiddleware(async (c, next) => {
  // SAFETY: c.env carries the control keys the runner deployed as worker vars; the stamp copies every declared string key.
  stampControlEnv(c.env as KitEnv);
  // SAFETY: DB is the D1 binding declared in void.config.ts; the middleware only stamps it when the platform injected a real binding.
  const d1 = c.env.DB as D1Database | undefined;

  if (d1) {
    setD1Binding(d1);
  }

  // Per request, never shared: a client abort or a fast answer drops the
  // starter's pending work, so a pass cached across requests would leave its
  // waiters on an orphan (see `docker/check-worker-rules.ts`). Schema
  // migrations are the runner's job (Void's migration endpoint), never a
  // request's. While they have not applied, every database touch fails with
  // a missing table — the bootstrap above, a page loader, an action — so
  // the whole downstream answers 503 here and the visitor waits instead of
  // seeing a broken UI. (The `await` on `next()` matters: without it a
  // downstream rejection skips the catch.)
  try {
    await ensureDb();

    return await next();
  } catch (error) {
    if (error instanceof DbUnavailableError || isMissingTableFailure(error)) {
      return new Response(DB_MIGRATING_BODY, {
        headers: { "retry-after": "5" },
        status: 503,
      });
    }

    throw error;
  }
});
