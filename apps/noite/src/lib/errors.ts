import * as Schema from "effect/Schema";

const isErrorLike = Schema.is(Schema.Struct({ message: Schema.String }));
const isText = Schema.is(Schema.String);

/** Text for any caught or loaded error.
 *
 * Oxide actions reject with the plain `{ message }` object of their tagged
 * error, not an `Error` instance, so `String(error)` renders it as
 * "[object Object]". Everything shown to a user goes through here instead. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site and resource().error values are unknown by construction; this narrows them to text.
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error || isErrorLike(error)) {
    return error.message;
  }
  if (isText(error)) {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};
