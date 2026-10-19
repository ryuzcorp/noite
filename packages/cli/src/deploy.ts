import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";

import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { connection } from "./config.js";
import {
  commentPr,
  parseCommentMode,
  readActionContext,
  writeOutputs,
} from "./gh.js";
import { copyTreeEntries, pushTree } from "./git.js";
import { withTempDir } from "./temp.js";

/** Default deploy message from the action sha or a timestamp. */
const defaultMessage = (sha: string | null): string =>
  `deploy ${sha === null ? new Date().toISOString() : sha.slice(0, 12)}`;

/** The app's public URL, derived from the git base the same way the edge
 * routes it: tenants serve at `{slug}.{base}` (the runner's Caddy tenant
 * sites), so `https://git.<domain>` deploys to `https://<slug>.<domain>`.
 * Scheme and port come from the git base itself:
 * `http://git.noite.localhost:9080` → `http://<slug>.noite.localhost:9080`.
 * `null` when the git base is not a URL. */
export const deployUrlOf = (gitBase: string, slug: string): string | null => {
  let url: URL;
  try {
    url = new URL(gitBase);
  } catch {
    return null;
  }
  const bare = url.hostname.startsWith("git.")
    ? url.hostname.slice("git.".length)
    : url.hostname;
  const base = bare.replace(/\.+$/u, "");
  if (base === "") {
    return null;
  }
  return `${url.protocol}//${slug}.${base}${url.port === "" ? "" : `:${url.port}`}`;
};

/** Assemble the deploy tree in `staging`: every top-level entry of the dist
 * dir (dotfiles included — `*` globs skip `.well-known/`) plus the wrangler
 * config at the root. */
export const stageDist = (
  distDir: string,
  staging: string,
  wrangler: string
): Effect.Effect<void, Error> =>
  Effect.gen(function* stage() {
    yield* copyTreeEntries(distDir, staging).pipe(
      Effect.mapError(
        () =>
          new Error(`assembling dist tree from ${distDir} failed (built yet?)`)
      )
    );
    yield* Effect.tryPromise({
      catch: () =>
        new Error(`assembling dist tree from ${distDir} failed (built yet?)`),
      try: async (): Promise<void> => {
        await cp(wrangler, `${staging}/wrangler.jsonc`);
      },
    });
  });

/** Stock remote URL for `slug`: the runner serves smart-HTTP at
 * `{GIT_PUBLIC_BASE}/{slug}` (`config.rs:git_http_url`), so a base with a
 * path (`http://localhost:8080/v1/git`) keeps it. */
export const remoteUrlOf = (
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
  const base = url.pathname.replace(/\/+$/u, "");
  return `${url.protocol}//git:${token}@${url.host}${base}/${slug}`;
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
      const conn = yield* connection(config, ctx.repo);
      const resolvedSlug = conn.slug;
      if (["app", "api", "git"].includes(resolvedSlug)) {
        return yield* Effect.fail(
          `slug ${resolvedSlug} is reserved (app/api/git)`
        );
      }
      const { gitBase, token } = conn;
      const remoteUrl = remoteUrlOf(gitBase, resolvedSlug, token);
      if (remoteUrl === null) {
        return yield* Effect.fail(`git base URL is malformed: ${gitBase}`);
      }
      const url = deployUrlOf(gitBase, resolvedSlug);
      if (url === null) {
        return yield* Effect.fail(`git base URL is malformed: ${gitBase}`);
      }

      // Assemble the tree: dist contents + wrangler config at root, no
      // package.json — the runner skips its source build and deploys dist.
      if (!existsSync(config.wrangler)) {
        return yield* Effect.fail(
          `wrangler config not found: ${config.wrangler}`
        );
      }
      const distDir = config.dist.replace(/\/+$/u, "");
      const message =
        config.message === "" ? defaultMessage(ctx.sha) : config.message;
      // The staging dir is removed on success; on failure it is kept and
      // warned about (`withTempDir`) for post-mortem.
      const sha = yield* withTempDir((staging) =>
        Effect.gen(function* stage() {
          yield* stageDist(distDir, staging, config.wrangler);
          return yield* pushTree({ message, remoteUrl, treeDir: staging });
        })
      );
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
