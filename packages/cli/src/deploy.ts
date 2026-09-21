import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  commentPr,
  parseCommentMode,
  readActionContext,
  writeOutputs,
} from "./gh.js";
import { pushTree } from "./git.js";

/** Lowercase slug-safe. Mirrors the server's naming rule loosely; the
 * runner is the final arbiter (unknown slugs 404 at auth). */
const sanitizeSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 63);

/** Resolve the deploy slug from --slug/NOITE_SLUG or the repo name. */
const resolveSlug = (flag: string, repo: string | null): string => {
  const direct = sanitizeSlug(flag);
  if (direct !== "") {
    return direct;
  }
  if (repo === null) {
    return "";
  }
  return sanitizeSlug(repo.split("/")[1] ?? "");
};

/** Default deploy message from the action sha or a timestamp. */
const defaultMessage = (sha: string | null): string =>
  `deploy ${sha === null ? new Date().toISOString() : sha.slice(0, 12)}`;
const appBaseOf = (gitBase: string): string | null => {
  let url: URL;
  try {
    url = new URL(gitBase);
  } catch {
    return null;
  }
  const host = url.hostname.startsWith("git.")
    ? url.hostname.slice("git.".length)
    : url.hostname;
  return `${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}`;
};

const remoteUrlOf = (
  gitBase: string,
  slug: string,
  token: string
): string | null => {
  let url: URL;
  try {
    url = new URL(gitBase);
  } catch {
    return null;
  }
  // Basic `git` + profile API key, same shape as deploy.sh remotes.
  return `${url.protocol}//git:${token}@${url.host}/${slug}`;
};

export const deploy = Command.make(
  "deploy",
  {
    comment: Flag.String("comment").pipe(
      Flag.withDescription("PR comment mode: update, create, or off"),
      Flag.withDefault("update")
    ),
    dist: Flag.String("dist").pipe(
      Flag.withDescription("Prebuilt dist directory to deploy"),
      Flag.withDefault("dist")
    ),
    message: Flag.String("message").pipe(
      Flag.withDescription(
        "Deploy commit message (default: deploy <sha|timestamp>)"
      ),
      Flag.withDefault("")
    ),
    slug: Flag.String("slug").pipe(
      Flag.withDescription(
        "App slug (default: NOITE_SLUG or repo name in Actions)"
      ),
      Flag.withDefault("")
    ),
    token: Flag.String("token").pipe(
      Flag.withDescription("Profile API key (default: NOITE_API_KEY)"),
      Flag.withDefault("")
    ),
    url: Flag.String("url").pipe(
      Flag.withDescription("Git base URL (default: GIT_PUBLIC_BASE)"),
      Flag.withDefault("")
    ),
    wrangler: Flag.String("wrangler").pipe(
      Flag.withDescription("Wrangler config file, copied to the dist root"),
      Flag.withDefault("wrangler.jsonc")
    ),
  },
  (config) =>
    Effect.gen(function* run() {
      const commentMode = parseCommentMode(config.comment);
      if (commentMode === null) {
        return yield* Effect.fail("--comment must be update, create, or off");
      }
      const ctx = yield* readActionContext();
      const { env } = process;

      const resolvedSlug = resolveSlug(
        config.slug === "" ? (env.NOITE_SLUG ?? "") : config.slug,
        ctx.repo
      );
      if (resolvedSlug === "") {
        return yield* Effect.fail(
          "slug required: --slug, NOITE_SLUG, or GITHUB_REPOSITORY"
        );
      }
      if (["app", "api", "git"].includes(resolvedSlug)) {
        return yield* Effect.fail(
          `slug ${resolvedSlug} is reserved (app/api/git)`
        );
      }
      const token =
        config.token === ""
          ? (env.NOITE_API_KEY ?? env.NOITE_GIT_TOKEN ?? "")
          : config.token;
      if (token === "") {
        return yield* Effect.fail(
          "API key required: --token or NOITE_API_KEY (Profile → API keys)"
        );
      }
      const gitBase = (
        config.url === ""
          ? (env.GIT_PUBLIC_BASE ??
            env.NOITE_BASE ??
            "http://git.localhost:9080")
          : config.url
      ).replace(/\/+$/u, "");
      const remoteUrl = remoteUrlOf(gitBase, resolvedSlug, token);
      if (remoteUrl === null) {
        return yield* Effect.fail(`git base URL is malformed: ${gitBase}`);
      }
      const appBase = appBaseOf(gitBase);
      if (appBase === null) {
        return yield* Effect.fail(`git base URL is malformed: ${gitBase}`);
      }

      // Assemble the tree: dist contents + wrangler config at root, no
      // package.json — the runner skips its source build and deploys dist.
      const wranglerFile = Bun.file(config.wrangler);
      if (!(yield* Effect.promise(() => wranglerFile.exists()))) {
        return yield* Effect.fail(
          `wrangler config not found: ${config.wrangler}`
        );
      }
      const distDir = config.dist.replace(/\/+$/u, "");
      const staging = yield* Effect.tryPromise({
        catch: () => new Error("mktemp failed"),
        try: () => Bun.$`mktemp -d`.text().then((s) => s.trim()),
      });
      yield* Effect.tryPromise({
        catch: () =>
          new Error(`assembling dist tree from ${distDir} failed (built yet?)`),
        try: async (): Promise<void> => {
          const glob = new Bun.Glob("*");
          for await (const entry of glob.scan({
            cwd: distDir,
            onlyFiles: false,
          })) {
            await Bun.$`cp -r ${`${distDir}/${entry}`} ${`${staging}/${entry}`}`.quiet();
          }
          await Bun.$`cp ${config.wrangler} ${staging}/wrangler.jsonc`.quiet();
        },
      });

      const message =
        config.message === "" ? defaultMessage(ctx.sha) : config.message;
      const sha = yield* pushTree({ message, remoteUrl, treeDir: staging });
      const url = `${appBase}/${resolvedSlug}`;
      yield* Effect.logInfo(
        `deployed ${resolvedSlug}@${sha.slice(0, 12)} → ${url}`
      );
      yield* writeOutputs({ outputFile: ctx.outputFile, sha, url });
      yield* commentPr({
        body: `🚀 Deploy \`${sha.slice(0, 12)}\` live → ${url}`,
        mode: commentMode,
        prNumber: ctx.prNumber,
        repo: ctx.repo,
      });
    })
).pipe(
  Command.withDescription(
    "Deploy a prebuilt dist directory over Git smart-HTTP"
  )
);
