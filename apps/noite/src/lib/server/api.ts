/**
 * Void JSON-action endpoints: the one factory every `lib/server/*.server.ts`
 * action module builds its route handlers from, plus the user-facing failure
 * the actions throw.
 *
 * Wire protocol (what the client in `lib/api.ts` and the `@ilha/void` form
 * story both read):
 * - success → 200 with the action's value as JSON (`undefined` answers
 *   `{ok: true}`, matching the existing `{ok: true}` returns).
 * - user-facing failure (`fail(message)`) → 422 `{errors: {form: message}}`,
 *   the `{errors}` shape Void's `getValidationErrors` reads, so a form can
 *   paint it without knowing the action.
 * - signed out / misconfigured auth (`UnauthorizedError`,
 *   `MissingAuthSecretError`) → 401 `{error: message}`.
 * - anything else (a bug, an unmapped throw) → 500 `{error: "Internal
 *   error"}`: a plain throw never leaks an implementation message to the
 *   browser (the old Oxide masking, kept).
 * - unreadable input → 400 `{error: "Invalid JSON"}` (oversize bodies reuse
 *   the HTTP layer's 413), a schema decode failure → 422
 *   `{errors: {form: "Invalid input"}}`.
 */
import * as Schema from "effect/Schema";
import { defineHandler } from "void";
import type { TypedHandler } from "void";

import { MAX_BODY_BYTES, readBoundedText, tooLarge } from "../../http/body";
import { errorMessage } from "../errors";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory (same pattern as lib/auth.ts)
export class ActionFailure extends Schema.TaggedError<ActionFailure>()(
  "ActionFailure",
  { message: Schema.String }
) {}

/** Throw a user-facing failure with `message` (never returns). */
export const fail = (message: string): never => {
  throw new ActionFailure({ message });
};

/** What an action body receives besides its decoded input. */
export interface ActionContext {
  env: KitEnv;
  request: Request;
}

/** Map a caught action error onto its status + JSON body (exported for the
 * unit test; the handler below is the only other caller). */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site values are unknown by construction; this maps them to wire responses.
export const actionErrorResponse = (error: unknown): Response => {
  const tag =
    error instanceof Error && "_tag" in error ? error._tag : undefined;
  if (tag === "UnauthorizedError" || tag === "MissingAuthSecretError") {
    return Response.json({ error: errorMessage(error) }, { status: 401 });
  }
  if (error instanceof ActionFailure) {
    return Response.json({ errors: { form: error.message } }, { status: 422 });
  }
  console.error(
    "[api]",
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  );
  return Response.json({ error: "Internal error" }, { status: 500 });
};

const readInput = async (
  request: Request,
  schema: Schema.ConstraintDecoder<unknown>
): Promise<{ input: unknown } | { response: Response }> => {
  const text = await readBoundedText(request, MAX_BODY_BYTES);
  if (text === null) {
    return { response: tooLarge() };
  }
  let raw: unknown;
  try {
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return {
      response: Response.json({ error: "Invalid JSON" }, { status: 400 }),
    };
  }
  try {
    return { input: Schema.decodeUnknownSync(schema)(raw) };
  } catch {
    return {
      response: Response.json(
        { errors: { form: "Invalid input" } },
        { status: 422 }
      ),
    };
  }
};

/** Define a Void JSON endpoint over a decoded input: read the bounded JSON
 * body, decode it through `schema`, run `fn`, answer the value as JSON. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- action outputs are per-action JSON values; the handler serializes them at this boundary.
export const apiAction = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- action bodies return per-action JSON values; the handler serializes them at this boundary.
  fn: (input: S["Type"], ctx: ActionContext) => Promise<unknown> | unknown
): TypedHandler =>
  defineHandler(async (c) => {
    const request = c.req.raw;
    // SAFETY: the platform injects every KitEnv control key the actions read; unset keys stay undefined as actions tolerate.
    const env = c.env as KitEnv;
    const read = await readInput(request, schema);
    if ("response" in read) {
      return read.response;
    }
    try {
      // SAFETY: readInput decoded this body through the same schema, so the unknown input is the schema's Type.
      const output = await fn(read.input as S["Type"], { env, request });
      return Response.json(output === undefined ? { ok: true } : output);
    } catch (error) {
      return actionErrorResponse(error);
    }
  });

/** Define a Void JSON endpoint with no input (the body, if any, is ignored). */
export const apiActionNoInput = (
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- action bodies return per-action JSON values; the handler serializes them at this boundary.
  fn: (ctx: ActionContext) => Promise<unknown> | unknown
): TypedHandler =>
  defineHandler(async (c) => {
    const request = c.req.raw;
    // SAFETY: the platform injects every KitEnv control key the actions read; unset keys stay undefined as actions tolerate.
    const env = c.env as KitEnv;
    try {
      const output = await fn({ env, request });
      return Response.json(output === undefined ? { ok: true } : output);
    } catch (error) {
      return actionErrorResponse(error);
    }
  });
