import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Data, Effect, Exit } from "effect";

/** What happens to a finished temp dir. The decision is one pure function
 * (`cleanupOf`) so the retention rule is testable without the filesystem.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> InUse: mkdtemp
 *   InUse --> Removed: use succeeded
 *   InUse --> Kept: use failed (post-mortem copy)
 * ```
 */
export type Cleanup = Data.TaggedEnum<{
  Kept: { readonly dir: string };
  Removed: Record<never, never>;
}>;

const { Kept, Removed } = Data.taggedEnum<Cleanup>();

/** Success removes; any failure (typed, defect, interrupt) keeps the dir. */
export const cleanupOf = (
  dir: string,
  exit: Exit.Exit<unknown, unknown>
): Cleanup => (Exit.isSuccess(exit) ? Removed() : Kept({ dir }));

export interface TempDirOptions {
  /** Runs before a failed dir is kept, so a caller can scrub secrets out of
   * it. Best effort: it must not turn a failure into a different one. */
  readonly onKeep?: (dir: string) => Effect.Effect<void, never>;
}

/** Run `use` with a fresh empty temp dir, removing it afterwards. A failure
 * keeps the dir and warns with its path instead: a kept dir can hold
 * credentials (the push workdir's `.git/config`), so `onKeep` gets a chance to
 * scrub them first. */
export const withTempDir = <A, E>(
  use: (dir: string) => Effect.Effect<A, E>,
  options: TempDirOptions = {}
): Effect.Effect<A, E | Error> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      catch: () => new Error("creating temp dir failed"),
      try: () => mkdtemp(path.join(tmpdir(), "noite-")),
    }),
    use,
    (dir, exit) => {
      const cleanup = cleanupOf(dir, exit);

      if (cleanup._tag === "Removed") {
        // Best effort: the work is already done, so a failed cleanup warns
        // instead of turning a successful command into a failure.
        return Effect.tryPromise({
          catch: (cause) =>
            new Error(`removing temp dir ${dir} failed: ${String(cause)}`),
          try: () => rm(dir, { force: true, recursive: true }),
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(`warning: ${cause.message}`)
          ),
          Effect.ignore
        );
      }

      return Effect.gen(function* keep() {
        const scrub = options.onKeep?.(dir);

        if (scrub !== undefined) {
          yield* scrub;
        }

        yield* Effect.logWarning(`keeping temp dir for inspection: ${dir}`);
      });
    }
  );
