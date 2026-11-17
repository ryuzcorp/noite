import { DB_MIGRATING_BODY } from "../lib/db";
import { errorLogText } from "../lib/errors";

/** Answer a route failure without echoing it. A database failure reaches the
 * route as drizzle's statement plus every bound parameter, and an uncaught
 * throw lands in Void's `console.error` in exactly that shape — so the route
 * logs the cause chain instead and answers a flat 500. Statuses the route
 * decided itself (401, 403, 400) are answered before this point and keep their
 * semantics. A missing table means the control migrations have not applied
 * yet (the runner is still retrying them): that answers 503 with
 * `retry-after`, never the 500 a half-migrated schema would otherwise read
 * as. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a route catch hands the raw thrown value; the formatter narrows it.
export const routeFailure = (scope: string, error: unknown): Response => {
  console.error(scope, errorLogText(error));

  const tag =
    error instanceof Error && "_tag" in error ? error._tag : undefined;

  if (tag === "DbUnavailableError") {
    return new Response(DB_MIGRATING_BODY, {
      headers: { "retry-after": "5" },
      status: 503,
    });
  }

  return new Response(null, { status: 500 });
};
