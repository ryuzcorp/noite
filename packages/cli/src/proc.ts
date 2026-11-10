import { spawnSync } from "node:child_process";

import { Effect } from "effect";

export interface ProcResult {
  readonly code: number;
  /** Trimmed. Read only on failure: it can carry a remote URL's token. */
  readonly stderr: string;
  readonly stdout: string;
}

/** The one process runner every command injects, so tests can answer without
 * a real binary. */
export type RunProc = (
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
) => Effect.Effect<ProcResult, Error>;

/** Run `command` with `args` (no shell, no interpolation) in `cwd`,
 * capturing stdout and stderr trimmed. Spawn failures (missing binary)
 * reject; a non-zero exit resolves, so the caller decides what it means.
 * `env` is merged onto the parent's environment when given. */
export const runProc: RunProc = (command, args, cwd, env) =>
  Effect.try({
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`${command} failed: ${String(cause)}`),
    try: (): ProcResult => {
      const proc = spawnSync(command, [...args], {
        cwd,
        encoding: "utf-8",
        env: env === undefined ? undefined : { ...process.env, ...env },
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (proc.error) {
        throw proc.error;
      }

      return {
        code: proc.status ?? 1,
        stderr: proc.stderr.trim(),
        stdout: proc.stdout.trim(),
      };
    },
  });
