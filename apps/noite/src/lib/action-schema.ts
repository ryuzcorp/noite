import type * as Schema from "effect/Schema";
import { withSchema } from "oxidejs";

/** withSchema variant with an honest awaited type. Oxide's withSchema
 * declares its return as `R | Effect<never, SchemaDecodeError>`, so every
 * awaited action reads as a data-or-Effect union. Decode failure rejects
 * instead of resolving, so the Effect branch is uninhabited post-await —
 * this keeps the identical function object (and its stamped payload meta)
 * while dropping that branch from the type. */
export const checkedSchema = <T, E, R>(
  schema: Schema.Codec<T, E, never, never>,
  handler: (payload: T) => R
): ((payload: E) => R) =>
  // SAFETY: same object withSchema returned (meta intact); only the
  // uninhabited decode-Effect union member is removed from the type.
  withSchema(schema, handler) as (payload: E) => R;
