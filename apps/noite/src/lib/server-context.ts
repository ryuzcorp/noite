/**
 * TRANSIENT (slice 2, Oxide→Void build/entry cutover): the server-action
 * protocol Oxide used to provide, preserved with identical semantics so the
 * 17 `lib/server/*.server.ts` action modules and the plain HTTP routes that
 * import them keep loading and behaving exactly as before.
 *
 * What each helper is:
 * - `fail` throws the user-facing `ActionFailure` (a `Schema.TaggedError`
 *   with `_tag "ActionFailure"`, exactly as oxidejs 0.6.1 threw it —
 *   `errorMessage` in `./errors` only reads `.message` off `Error`, so the
 *   user-facing text is unchanged).
 * - `useEnv`/`useRequest` read the request store Oxide entered around
 *   actions. There is no store in this slice, so both throw outside one —
 *   exactly as Oxide's did outside request handling. Every caller either
 *   try/catches into a stamped/process fallback (`lib/db.ts`,
 *   `lib/runner.ts`) or only runs inside request handling.
 * - `action` is the identity: Oxide's `action(fn)` returned a directly
 *   callable handle server-side (RPC branding only affected the client
 *   bundler transform). No caller in `bun test src` invokes an action
 *   handle; the bodies stay inert definitions until the routes slice wires
 *   them to Void handlers.
 * - `withSchema` decodes the input through the Effect Schema before calling
 *   the body, as Oxide's did (a decode failure throws `ParseError` instead
 *   of Oxide's `SchemaDecodeError` wrapper — no caller catches that class).
 *
 * Owned by the routes/actions slices: they replace `action`/`withSchema`
 * with Void `defineHandler` routes (or `pages/*.server.ts` actions) and
 * `useEnv`/`useRequest` with `c.env`/handler args, then delete this module.
 */
import * as Schema from "effect/Schema";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory (same pattern as lib/auth.ts)
export class ActionFailure extends Schema.TaggedError<ActionFailure>()(
  "ActionFailure",
  { message: Schema.String }
) {}

/** Throw a user-facing failure with `message` (never returns). */
export const fail = (message: string): never => {
  throw new ActionFailure({ message });
};

/** Request-scoped Worker env. Throws outside request handling (no store). */
export const useEnv = <T>(): T => {
  throw new Error(
    "noite: useEnv outside request handling (the Oxide request store is gone; the routes slice passes c.env instead)"
  );
};

/** The current server `Request`. Throws outside request handling. */
export const useRequest = (): Request => {
  throw new Error(
    "noite: useRequest outside request handling (the Oxide request store is gone; the routes slice passes the request instead)"
  );
};

/** Validate `input` through `schema` before calling the action body,
 * preserving the body's input and return types. */
export const withSchema = <S extends Schema.ConstraintDecoder<unknown>, R>(
  schema: S,
  fn: (decoded: S["Type"]) => R
): ((input: Schema.Codec.Encoded<S>) => Promise<Awaited<R>>) => {
  const decode = Schema.decodeUnknownSync(schema);
  const run = async (input: Schema.Codec.Encoded<S>): Promise<Awaited<R>> =>
    await fn(decode(input));
  return run;
};
/** Oxide's trailing action options: the declared `{ error }` failure schema.
 * Accepted and ignored — failures stay thrown `Schema.TaggedError`s until the
 * routes slice maps them onto Void responses. */
export interface ActionOptions {
  error?: Schema.Schema<unknown>;
}
/** Define a server action: the identity (handles stay directly callable). */
// oxlint-disable-next-line anti-slop/no-unsafe-function-type -- any function shape, preserved exactly (Oxide's action() took any body)
// oxlint-disable-next-line anti-slop/no-unknown-returns -- the identity preserves any body shape exactly (Oxide's action() took any body)
export const action = <F extends (...args: never[]) => unknown>(
  fn: F,
  _options?: ActionOptions
): F => fn;
