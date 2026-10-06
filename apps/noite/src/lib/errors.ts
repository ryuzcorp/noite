/** Text for any caught or loaded error.
 *
 * Action calls reject with Error instances (oxidejs `ActionError`,
 * `ActionFailure`, a declared `Schema.TaggedError`), so `.message` is the
 * user-facing text. Non-Error throw values (a string, a rejected resource
 * fetch) still need to render as text rather than "[object Object]". */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site and resource().error values are unknown by construction; this narrows them to text.
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
