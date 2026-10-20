/**
 * Trailing-slash alias for the Sentry envelope endpoint: the stock SDK
 * posts `POST /api/<n>/envelope/` (trailing slash), but Void maps
 * `routes/api/[projectId]/envelope.ts` to the slash-less path and Hono
 * routes strictly, so the slash variant would 404 and the SDK would retry.
 * This middleware answers the slash variant with the same handler before
 * routing; the slash-less path keeps flowing to the route file.
 */
import { defineMiddleware } from "void";

import { handleEnvelope } from "../http/routes/envelope";

const ENVELOPE_SLASH = /^\/api\/(?<projectId>\d+)\/envelope\/$/u;

export default defineMiddleware(async (c, next) => {
  const slash = ENVELOPE_SLASH.exec(c.req.path);

  if (!slash?.groups) {
    return next();
  }

  // SAFETY: the envelope handler reads only RUNNER_TOKEN/RUNNER_URL off the env, like every http route.
  const response = await handleEnvelope(c.req.raw, c.env as KitEnv, {
    projectId: slash.groups.projectId,
  });

  return response ?? new Response("Not Found", { status: 404 });
});
