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
import { stampControlEnv } from "../lib/control-env";

/** The Worker env as the control routes read it (strings plus bindings). */
const kitEnv = (c: CloudContext): KitEnv =>
  // SAFETY: the platform injects every KitEnv control key the handlers read; unset keys stay undefined as handlers tolerate.
  c.env as KitEnv;

/** Expose a plain-HTTP route as a Void handler (declines become 404). The
 * stamp lives here as well as in the middleware, so no plain route depends
 * on middleware ordering to see the deployed env. */
export const route = (handler: RouteHandler) =>
  defineHandler((c: CloudContext) => {
    // SAFETY: Hono exposes every `:param` (and the `:rest{.+}` catch-all) here; names this route never declares stay undefined.
    const params = c.req.param() as Record<string, string | undefined>;
    const env = kitEnv(c);

    stampControlEnv(env);

    return (
      handler(c.req.raw, env, params) ??
      new Response("Not Found", { status: 404 })
    );
  });
