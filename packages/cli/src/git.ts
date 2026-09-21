import { Effect } from "effect";

/** Run git in cwd, resolving stdout. Rejects with scrubbed stderr. */
const runGit = (
  args: readonly string[],
  cwd: string
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`git failed: ${String(cause)}`),
    try: async (): Promise<string> => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new Error(
          `git ${args[0] ?? ""} failed: ${err.trim() || `exit ${code}`}`
        );
      }
      return out.trim();
    },
  });

/** Current `refs/heads/main` tip on the remote, if the ref exists yet. */
// ls-remote exits 0 with empty stdout when the ref is missing, so any
// error here is real (auth/network) and must surface.
export const lsRemoteTip = (
  remoteUrl: string
): Effect.Effect<string | null, Error> =>
  Effect.gen(function* run() {
    const out = yield* runGit(
      ["ls-remote", remoteUrl, "refs/heads/main"],
      process.cwd()
    );
    const sha = out.split("\t")[0]?.trim();
    return sha !== undefined && sha !== "" ? sha : null;
  });

export interface PushInput {
  readonly remoteUrl: string;
  /** Assembled tree: dist contents + wrangler.jsonc at root. */
  readonly treeDir: string;
  readonly message: string;
}

/**
 * Push a dist tree as a synthetic commit parented on the remote tip, so
 * the push is always fast-forward (works with the `push` role — never
 * force). First deploy (no remote ref) creates it. Resolves the new sha.
 */
export const pushTree = (input: PushInput): Effect.Effect<string, Error> =>
  Effect.gen(function* run() {
    const tip = yield* lsRemoteTip(input.remoteUrl);
    const workdir = yield* Effect.tryPromise({
      catch: () => new Error("mktemp failed"),
      try: () => Bun.$`mktemp -d`.text().then((s) => s.trim()),
    });
    if (tip === null) {
      yield* runGit(["init", "-b", "main"], workdir);
      yield* runGit(["remote", "add", "origin", input.remoteUrl], workdir);
    } else {
      yield* runGit(
        ["clone", "--depth", "1", "--branch", "main", input.remoteUrl, "."],
        workdir
      );
      // Empty the old dist, keep the fresh clone's .git for ancestry.
      yield* runGit(["rm", "-r", "--cached", "."], workdir);
      yield* Effect.tryPromise({
        catch: () => new Error("clearing previous dist failed"),
        try: async (): Promise<void> => {
          const glob = new Bun.Glob("*");
          for await (const entry of glob.scan({
            cwd: workdir,
            onlyFiles: false,
          })) {
            if (entry === ".git" || entry.startsWith(".git/")) {
              continue;
            }
            await Bun.$`rm -rf ${workdir}/${entry}`.quiet();
          }
        },
      });
    }
    yield* Effect.tryPromise({
      catch: () => new Error(`copying ${input.treeDir} failed`),
      try: async (): Promise<void> => {
        const glob = new Bun.Glob("*");
        for await (const entry of glob.scan({
          cwd: input.treeDir,
          onlyFiles: false,
        })) {
          await Bun.$`cp -r ${`${input.treeDir}/${entry}`} ${`${workdir}/${entry}`}`.quiet();
        }
      },
    });
    yield* runGit(["add", "-A"], workdir);
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
      workdir
    );
    yield* runGit(["push", "-u", "origin", "main"], workdir);
    return yield* runGit(["rev-parse", "HEAD"], workdir);
  });
