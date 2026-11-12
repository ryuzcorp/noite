import { errorLogText } from "../lib/errors";

/** Answer a route failure without echoing it. A database failure reaches the
 * route as drizzle's statement plus every bound parameter, and an uncaught
 * throw lands in Void's `console.error` in exactly that shape — so the route
 * logs the cause chain instead and answers a flat 500. Statuses the route
 * decided itself (401, 403, 400) are answered before this point and keep their
 * semantics. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route catch hands the raw thrown value; the formatter narrows it.
export const routeFailure = (scope: string, error: unknown): Response => {
  console.error(scope, errorLogText(error));

  return new Response(null, { status: 500 });
};
