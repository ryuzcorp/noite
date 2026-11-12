/**
 * Typed `fetch` for the Void JSON-action endpoints (`POST /api/<module>/
 * <action>`, built by `lib/server/api.ts`): the client half of the
 * server-action story. Every action call is `api<T>(path, input)` — a POST
 * with a JSON body whose session cookie rides along, so `errorMessage(error)`
 * at the call site keeps rendering the user-facing text exactly as it did
 * for action rejections.
 */
import type { FieldErrors } from "@ilha/void";

/** A rejected action call: `message` is the user-facing text (the 422
 * `{errors}` values joined, like Void's `formErrorMessage`, or the `{error}`
 * body), `status` the HTTP status, `errors` the 422 field map when there is
 * one (a form paints it per field). */
export class ApiError extends Error {
  errors: FieldErrors | null;
  status: number;

  constructor(
    status: number,
    message: string,
    errors: FieldErrors | null = null
  ) {
    super(message);
    this.name = "ApiError";
    this.errors = errors;
    this.status = status;
  }
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the action-error boundary: a rejected endpoint's JSON body is I/O, and this is the one place that maps it onto thrown text. Every field is checked here before it is read. */
/** Read a Void 422 `{errors}` body (the same protocol as Void's
 * `getValidationErrors`): the field map, or null when the body carries
 * none. Exported so forms can paint field errors without throwing. */
export const apiErrors = (body: unknown): FieldErrors | null => {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("errors" in body)
  ) {
    return null;
  }

  const raw = body.errors;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const fields: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      fields[key] = value;
    }
  }

  return Object.keys(fields).length > 0 ? fields : null;
};

/** The `{error}` field of a refusal body (the control's and the runner's
 * envelope), or null when the body carries none. Exported for the routes that
 * forward the runner body verbatim but not as a Void action. */
export const errorBody = (body: unknown): string | null => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  if (!("error" in body) || typeof body.error !== "string") {
    return null;
  }

  return body.error;
};

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** Client-side bound on one action round trip. The server answers a stuck
 * action itself (15 s, `middleware/01-timeout.ts`); this only covers a
 * connection that never reaches it — a dead network, a stalled proxy — so
 * the failure reads as a timeout instead of hanging the form forever. */
export const API_TIMEOUT_MS = 20_000;

/** The transport failure as text: a timeout says what to wait for, anything
 * else is the browser's own network error (never a bare "fetch failed"). */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected fetch value is unknown by construction; this maps it onto text.
export const transportMessage = (error: unknown, timeoutMs: number): string => {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return `the server didn't answer within ${Math.round(timeoutMs / 1000)} s`;
  }

  return `network error: ${error instanceof Error ? error.message : String(error)}`;
};

/** `response.json()` with the request's transport mapping: the abort signal
 * also covers the body read, so a body that stalls after the headers is the
 * same user-facing timeout as a stalled connection. A malformed body is a
 * protocol failure, not a transport one, and says so. */
/* oxlint-disable anti-slop/no-unknown-returns -- the raw JSON boundary; `api` casts the value to the caller's type right after. */
const readJson = async (
  response: Response,
  malformed: string
): Promise<unknown> => {
  try {
    return await response.json();
  } catch (error) {
    throw error instanceof SyntaxError
      ? new ApiError(response.status, malformed, null)
      : new ApiError(0, transportMessage(error, API_TIMEOUT_MS), null);
  }
};
/* oxlint-enable anti-slop/no-unknown-returns */

/** POST `input` as JSON to a JSON-action endpoint and read the value back.
 * Rejects with `ApiError` whose `message` is the user-facing text. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the JSON-action client boundary: the input shape is the endpoint's contract, serialized here.
export const api = async <T>(path: string, input: unknown): Promise<T> => {
  let response: Response;

  try {
    response = await fetch(path, {
      body: JSON.stringify(input ?? {}),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    // Status 0: the request never got an answer, so there is no HTTP status.
    throw new ApiError(0, transportMessage(error, API_TIMEOUT_MS), null);
  }

  if (response.ok) {
    // SAFETY: the endpoint answers the action's value as JSON; the caller names its type.
    return (await readJson(
      response,
      "the server sent an unreadable answer"
    )) as T;
  }

  const body = await readJson(response, `Request failed (${response.status})`);

  const errors = response.status === 422 ? apiErrors(body) : null;

  const fields = errors
    ? Object.values(errors).filter((value) => value !== "")
    : [];

  const message =
    fields.length > 0
      ? fields.join(". ")
      : (errorBody(body) ?? `Request failed (${response.status})`);

  throw new ApiError(response.status, message, errors);
};
