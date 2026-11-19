import { errorLogText } from "../lib/errors";

/** Answer a route failure without echoing it. A database failure reaches the
 * route as drizzle's statement plus every bound parameter, and an uncaught
 * throw lands in Void's `console.error` in exactly that shape — so the route
 * logs the cause chain instead and answers a flat 500. Statuses the route
 * decided itself (401, 403, 400) are answered before this point and keep their
 * semantics. On a fresh database the control UI can receive requests while
 * the runner still applies migrations in the background: the listener binds
 * and the control fleet deploys before the first migration attempt, which
 * then retries (`apps/runner/src/main.rs`). A request that arrives in that
 * window is answered 503 with `retry-after` by the DB middleware
 * (`middleware/03-db.ts`) before routes run — and the action factory
 * (`lib/server/api.ts`) maps a `DbUnavailableError` the same way — so this
 * catch only sees post-gate failures: bugs, or a database wiped mid-boot.
 * Those stay a flat 500. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route catch hands the raw thrown value; the formatter narrows it.
export const routeFailure = (scope: string, error: unknown): Response => {
  console.error(scope, errorLogText(error));

  return new Response(null, { status: 500 });
};
