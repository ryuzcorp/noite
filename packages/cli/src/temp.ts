import { Effect, Exit } from "effect";

/** Run `use` with a fresh empty temp dir, removing it afterwards. A failure
 * keeps the dir and warns with its path instead: the push workdir's
 * `.git/config` holds the profile API key, so a kept dir is called out
 * loudly rather than silently left in `/tmp`. */
export const withTempDir = <A, E>(
  use: (dir: string) => Effect.Effect<A, E>
): Effect.Effect<A, E | Error> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      catch: () => new Error("mktemp failed"),
      try: async (): Promise<string> => {
        const out = await Bun.$`mktemp -d`.text();
        return out.trim();
      },
    }),
    use,
    (dir, exit) =>
      Exit.isSuccess(exit)
        ? Effect.tryPromise({
            catch: () => new Error(`removing temp dir ${dir} failed`),
            try: () => Bun.$`rm -rf ${dir}`.quiet(),
          })
        : Effect.logWarning(`keeping temp dir for inspection: ${dir}`).pipe(
            Effect.asVoid
          )
  );
