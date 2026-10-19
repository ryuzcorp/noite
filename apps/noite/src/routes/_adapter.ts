/**
 * One-line bridge from a Void handler to the `(request, env, params)` route
 * logic in `src/http/`: the files under `src/routes/` name the URL space,
 * the logic stays unit-testable without a Hono context.
 *
 * (Underscore-prefixed: Void never scans this file as a route.)
 */
import { defineHandler } from "void";
import type { CloudContext } from "void";

import type { RouteHandler } from "../http/config";

/** The Worker env as the control routes read it (strings plus bindings). */
const kitEnv = (c: CloudContext): KitEnv =>
  // SAFETY: the platform injects every KitEnv control key the handlers read; unset keys stay undefined as handlers tolerate.
  c.env as KitEnv;

/** Expose a plain-HTTP route as a Void handler (declines become 404). */
export const route = (handler: RouteHandler) =>
  defineHandler((c: CloudContext) => {
    // SAFETY: Hono exposes every `:param` (and the `:rest{.+}` catch-all) here; names this route never declares stay undefined.
    const params = c.req.param() as Record<string, string | undefined>;
    return (
      handler(c.req.raw, kitEnv(c), params) ??
      new Response("Not Found", { status: 404 })
    );
  });
