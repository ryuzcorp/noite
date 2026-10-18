/**
 * Stamp the Worker D1 binding, then ensure the schema before routes / pages.
 * Runs on every request (root `middleware/` = Void global middleware).
 */

import type { D1Database } from "@cloudflare/workers-types";
import { defineMiddleware } from "void";

import { ensureDbPromise, setD1Binding } from "../src/lib/db";

export default defineMiddleware(async (c, next) => {
  // SAFETY: DB is the D1 binding declared in void.config.ts; the middleware only stamps it when the platform injected a real binding.
  const d1 = c.env.DB as D1Database | undefined;
  if (d1) {
    setD1Binding(d1);
  }
  await ensureDbPromise();
  return next();
});
