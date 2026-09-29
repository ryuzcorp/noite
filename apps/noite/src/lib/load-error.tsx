/** Inline "failed to load" line for a resource's `error()` (typed unknown
 * by ilha). Renders nothing when there is no error. */
export const LoadError = ({
  error,
  label = "Failed to load",
}: {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- resource().error is unknown by contract; this only renders it.
  error: unknown;
  label?: string;
}) => {
  if (!error) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p class="text-error m-0 text-sm">
      {label}: {message}
    </p>
  );
};
