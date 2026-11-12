/** Text for any caught or loaded error.
 *
 * Action calls reject with Error instances (a user-facing `ActionFailure`,
 * a declared `Schema.TaggedError`, an `ApiError`), so `.message` is the
 * user-facing text. Effect's shorthand wrappers (`Effect.tryPromise(() => …)`
 * and `Effect.try(() => …)`) reject with an `UnknownError` whose own message
 * is the library default "An error occurred in Effect.tryPromise" and whose
 * `cause` is the real failure; unwrapping it here keeps that default out of
 * every UI, for every call site at once. Drizzle's `DrizzleQueryError` is the
 * other wrapper: its message is the whole SQL text plus every bound
 * parameter, so the driver failure in its `cause` is the only part fit to
 * read (and the part an operator needs). Non-Error throw values (a string, a
 * rejected resource fetch) still render as text rather than "[object Object]".
 */
import { Cause } from "effect";

import { ApiError } from "./api";

/** Wrappers can nest (`tryPromise(() => tryPromise(…))`); bail out rather than
 * walk a cyclic cause chain forever. */
const MAX_CAUSE_DEPTH = 4;

/** Drizzle's query error, recognized by its own shape: the class is exported
 * only from `drizzle-orm/errors`, which this app does not depend on. */
interface QueryError {
  params: unknown[];
  query: string;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site and wrapper values are unknown by construction; this is the one place that narrows them.
const asQueryError = (error: unknown): (Error & QueryError) | null => {
  if (!(error instanceof Error)) {
    return null;
  }

  const candidate: Error & Partial<QueryError> = error;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the wrapper is recognized by the fields the driver sets on it; no module this app depends on exports its class.
  if (typeof candidate.query !== "string" || !Array.isArray(candidate.params)) {
    return null;
  }

  // SAFETY: both fields were just checked, so the wrapper's shape is exact.
  return candidate as Error & QueryError;
};

/** A wrapper whose cheap-to-ignore text hides the failure it carries. */
const isWrapper = (error: Error): boolean =>
  Cause.isUnknownError(error) || asQueryError(error) !== null;

/** The text of the underlying failure, with the wrapper peeled off. Wrappers
 * are recognized by effect's own predicate or drizzle's shape, never by the
 * English message. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site values are unknown by construction; this is the one place that narrows them.
const detail = (error: unknown, depth: number): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (
    depth < MAX_CAUSE_DEPTH &&
    isWrapper(error) &&
    error.cause !== undefined
  ) {
    return detail(error.cause, depth + 1);
  }

  if (asQueryError(error) !== null) {
    // The loop above always unwraps a query to its driver failure; reaching
    // here means there is none, and the wrapper's own text is the SQL plus
    // every bound parameter — never the user's to read.
    return "Database query failed";
  }

  // A server-side failure carries its HTTP status: a 5xx is an outage the
  // operator must see, while a 4xx message already explains the refusal.
  const status =
    error instanceof ApiError && error.status >= 500
      ? ` (HTTP ${error.status})`
      : "";

  return `${error.message}${status}`;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site and resource().error values are unknown by construction; this narrows them to text.
export const errorMessage = (error: unknown): string => detail(error, 0);

/** Whether the failure chain wraps a database query: the SQL text and bound
 * parameters live there, so a caller that answers the user has to substitute
 * its own message instead of echoing the driver's. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site boundary, same as errorMessage.
export const isQueryFailure = (error: unknown): boolean => {
  let current = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      return false;
    }

    if (asQueryError(current) !== null) {
      return true;
    }

    if (!(Cause.isUnknownError(current) && current.cause !== undefined)) {
      return false;
    }

    current = current.cause;
  }

  return false;
};

/** The server log's text: every link of the cause chain, so a wrapped driver
 * failure is never hidden behind the wrapper's stack alone. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- api.ts's catch boundary; see errorMessage.
export const errorLogText = (error: unknown): string => {
  const parts: string[] = [];
  let current = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));

      break;
    }

    parts.push(current.stack ?? `${current.name}: ${current.message}`);

    if (!(isWrapper(current) && current.cause !== undefined)) {
      break;
    }

    current = current.cause;
  }

  return parts.join("\nCaused by: ");
};

/** What the user sees for a failed operation: what it was trying to do, then
 * the server's own message (or the transport failure). One shape for every
 * command, so a failure can never reach the UI as a bare library default. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- same catch-site boundary as errorMessage, which performs the narrowing.
export const operationMessage = (operation: string, error: unknown): string =>
  `${operation}: ${errorMessage(error)}`;
