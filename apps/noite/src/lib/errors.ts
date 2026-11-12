/** Text for any caught or loaded error.
 *
 * Action calls reject with Error instances (a user-facing `ActionFailure`,
 * a declared `Schema.TaggedError`, an `ApiError`), so `.message` is the
 * user-facing text. Effect's shorthand wrappers (`Effect.tryPromise(() => …)`
 * and `Effect.try(() => …)`) reject with an `UnknownError` whose own message
 * is the library default "An error occurred in Effect.tryPromise" and whose
 * `cause` is the real failure; unwrapping it here keeps that default out of
 * every UI, for every call site at once. Non-Error throw values (a string, a
 * rejected resource fetch) still render as text rather than "[object Object]".
 */
import { Cause } from "effect";

import { ApiError } from "./api";

/** Wrappers can nest (`tryPromise(() => tryPromise(…))`); bail out rather than
 * walk a cyclic cause chain forever. */
const MAX_CAUSE_DEPTH = 4;

/** The text of the underlying failure, with the wrapper peeled off. Wrappers
 * are recognized by effect's own predicate, never by the English message. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site values are unknown by construction; this is the one place that narrows them.
const detail = (error: unknown, depth: number): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (
    depth < MAX_CAUSE_DEPTH &&
    Cause.isUnknownError(error) &&
    error.cause !== undefined
  ) {
    return detail(error.cause, depth + 1);
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

/** What the user sees for a failed operation: what it was trying to do, then
 * the server's own message (or the transport failure). One shape for every
 * command, so a failure can never reach the UI as a bare library default. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- same catch-site boundary as errorMessage, which performs the narrowing.
export const operationMessage = (operation: string, error: unknown): string =>
  `${operation}: ${errorMessage(error)}`;
