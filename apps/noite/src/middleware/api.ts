/**
 * Health / webhook / Better Auth sit in front of actions + static.
 * Under the worker preset the platform always injects the Worker env.
 */
import { handleHttp } from "../http/routes";

export default function apiRoutes(request: Request, context: { env?: KitEnv }) {
  // SAFETY: the Worker env carries every KitEnv key; an empty bag only guards a hypothetical un-injected env, and handlers tolerate unset keys.
  return handleHttp(request, (context.env ?? {}) as KitEnv);
}
