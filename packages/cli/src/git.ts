import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Data, Effect } from "effect";

import { runProc } from "./proc.js";
import { withTempDir } from "./temp.js";

/** Run git in cwd, resolving stdout. Rejects with scrubbed stderr. `env` is
 * merged onto the parent's environment (the auth header travels that way). */
const runGit = (
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Effect.Effect<string, Error> =>
  Effect.gen(function* run() {
    const proc = yield* runProc("git", args, cwd, env);

    if (proc.code !== 0) {
      return yield* Effect.fail(
        new Error(
          `git ${args[0] ?? ""} failed: ${proc.stderr || `exit ${proc.code}`}`
        )
      );
    }

    return proc.stdout;
  });

/** Which remote shape a push targets, decided once by `remoteState`:
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Bootstrap: ls-remote has no refs/heads/main
 *   [*] --> FastForward: refs/heads/main exists
 * ```
 *
 * `Bootstrap` creates the ref (`init` + `remote add`); `FastForward` clones
 * the existing tip and commits on top of it. */
export type PushMode = Data.TaggedEnum<{
  Bootstrap: Record<never, never>;
  FastForward: Record<never, never>;
}>;

const { Bootstrap, FastForward } = Data.taggedEnum<PushMode>();

/** GitHub-style Basic `git` + profile key, supplied to git through
 * `GIT_CONFIG_*` so it never appears in a remote URL, `.git/config`, or a
 * process argument list. The `http.<url>.extraHeader` key scopes the header
 * to the deploy remote's origin and path, so a followed redirect to another
 * host never receives the key. `GIT_TERMINAL_PROMPT=0` keeps a rejected key
 * from hanging a CI step on a credential prompt. */
export const gitAuthEnv = (
  token: string,
  remoteUrl: string
): NodeJS.ProcessEnv => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `http.${remoteUrl}.extraHeader`,
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`git:${token}`).toString("base64")}`,
  GIT_TERMINAL_PROMPT: "0",
});

/** Strip URL userinfo out of a workdir's `.git/config` before it is kept for
 * inspection. Best effort: a missing or unreadable config is already clean. */
export const scrubGitConfig = (dir: string): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    try {
      const config = path.join(dir, ".git", "config");
      const text = await readFile(config, "utf-8");

      const scrubbed = text.replaceAll(
        /(?<prefix>url = [a-z]+:\/\/)[^/@\s]+@/gu,
        "$<prefix>"
      );

      if (scrubbed !== text) {
        await writeFile(config, scrubbed);
      }
    } catch {
      // No config (git init failed) or not readable: nothing to scrub.
    }
  });

/** Current `refs/heads/main` tip on the remote, if the ref exists yet. */
// ls-remote exits 0 with empty stdout when the ref is missing, so any
// error here is real (auth/network) and must surface.
export const lsRemoteTip = (
  remoteUrl: string,
  token: string
): Effect.Effect<string | null, Error> =>
  Effect.gen(function* run() {
    const out = yield* runGit(
      ["ls-remote", remoteUrl, "refs/heads/main"],
      process.cwd(),
      gitAuthEnv(token, remoteUrl)
    );

    const sha = out.split("\t")[0]?.trim();

    return sha !== undefined && sha !== "" ? sha : null;
  });

/** Probe once, decide once: does the push create `main` or fast-forward it? */
export const remoteState = (
  remoteUrl: string,
  token: string
): Effect.Effect<PushMode, Error> =>
  Effect.map(lsRemoteTip(remoteUrl, token), (tip) =>
    tip === null ? Bootstrap() : FastForward()
  );

export interface PushInput {
  readonly message: string;
  /** Test/diagnostic seam: runs before a failed workdir is kept. */
  readonly onKeep?: (dir: string) => Effect.Effect<void, never>;
  /** Token-free remote URL: `remoteUrlOf` never embeds the key. */
  readonly remoteUrl: string;
  readonly token: string;
  /** Assembled tree: dist contents + wrangler.jsonc at root. */
  readonly treeDir: string;
}

/**
 * Copy every top-level entry of `src` into `dest`. `readdir` (unlike a `*`
 * glob) sees dotfiles, so `.well-known/` and friends survive the trip.
 */
export const copyTreeEntries = (
  src: string,
  dest: string
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    catch: () => new Error(`copying ${src} failed`),
    try: async (): Promise<void> => {
      const entries = await readdir(src);
      await Promise.all(
        entries.map((entry) =>
          cp(path.join(src, entry), path.join(dest, entry), {
            recursive: true,
          })
        )
      );
    },
  });

/**
 * Empty a fresh clone's workdir, keeping `.git` for ancestry. Dotfiles are
 * removed too — a previous deploy's `.well-known/` must not survive a
 * redeploy that drops it.
 */
export const clearWorkdir = (workdir: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    catch: () => new Error("clearing previous dist failed"),
    try: async (): Promise<void> => {
      const entries = await readdir(workdir);
      await Promise.all(
        entries
          .filter((entry) => entry !== ".git")
          .map((entry) =>
            rm(path.join(workdir, entry), { force: true, recursive: true })
          )
      );
    },
  });

/**
 * Push a dist tree as a synthetic commit parented on the remote tip, so
 * the push is always fast-forward (works with the `push` role — never
 * force). First deploy (no remote ref) creates it. Resolves the new sha.
 * The workdir is removed on success; on failure it is kept and warned
 * about (`withTempDir`), with any URL credentials scrubbed first.
 */
export const pushTree = (input: PushInput): Effect.Effect<string, Error> =>
  Effect.gen(function* run() {
    const mode = yield* remoteState(input.remoteUrl, input.token);
    const env = gitAuthEnv(input.token, input.remoteUrl);

    return yield* withTempDir(
      (workdir) =>
        Effect.gen(function* push() {
          if (mode._tag === "Bootstrap") {
            yield* runGit(["init", "-b", "main"], workdir, env);
            yield* runGit(
              ["remote", "add", "origin", input.remoteUrl],
              workdir,
              env
            );
          } else {
            yield* runGit(
              [
                "clone",
                "--depth",
                "1",
                "--branch",
                "main",
                input.remoteUrl,
                ".",
              ],
              workdir,
              env
            );
            // Empty the old dist, keep the fresh clone's .git for ancestry.
            yield* runGit(["rm", "-r", "--cached", "."], workdir, env);
            yield* clearWorkdir(workdir);
          }

          yield* copyTreeEntries(input.treeDir, workdir);
          yield* runGit(["add", "-A"], workdir, env);
          yield* runGit(
            [
              "-c",
              "user.name=Noite",
              "-c",
              "user.email=noite@local",
              "commit",
              "-m",
              input.message,
            ],
            workdir,
            env
          );
          yield* runGit(["push", "-u", "origin", "main"], workdir, env);

          return yield* runGit(["rev-parse", "HEAD"], workdir, env);
        }),
      {
        onKeep: (dir) =>
          Effect.gen(function* retain() {
            yield* scrubGitConfig(dir);

            if (input.onKeep !== undefined) {
              yield* input.onKeep(dir);
            }
          }),
      }
    );
  });
