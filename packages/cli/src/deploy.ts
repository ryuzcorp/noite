import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";

import { Data, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { connection } from "./config.js";
import {
  commentPr,
  parseCommentMode,
  readActionContext,
  writeOutputs,
} from "./gh.js";
import type { CommentOutcome } from "./gh.js";
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
 * path (`http://localhost:8080/v1/git`) keeps it. Deliberately token-free:
 * the profile key travels in `gitAuthEnv`, so a retained workdir never holds
 * it. */
export const remoteUrlOf = (gitBase: string, slug: string): string | null => {
  let url: URL;

  try {
    url = new URL(gitBase);
  } catch {
    return null;
  }

  const base = url.pathname.replace(/\/+$/u, "");

  return `${url.protocol}//${url.host}${base}/${slug}`;
};

/** The deploy pipeline's phases, in order. The `Pushed → Recorded` edge is
 * the `$GITHUB_OUTPUT` write, and it is the only way to reach `Reported`, so
 * a live deploy records its result before the log line and before the
 * soft-failing PR comment:
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Prepared
 *   Prepared --> Staged: dist assembled
 *   Staged --> Pushed: git push accepted
 *   Pushed --> Recorded: $GITHUB_OUTPUT appended
 *   Recorded --> Reported: PR comment attempted
 * ```
 */
export type DeployPhase = Data.TaggedEnum<{
  Prepared: Record<never, never>;
  Pushed: Record<never, never>;
  Recorded: Record<never, never>;
  Reported: { readonly comment: CommentOutcome };
  Staged: Record<never, never>;
}>;

export const DeployPhases = Data.taggedEnum<DeployPhase>();

export type DeployEvent = Data.TaggedEnum<{
  Pushed: Record<never, never>;
  Recorded: Record<never, never>;
  Reported: { readonly comment: CommentOutcome };
  Staged: Record<never, never>;
}>;

export const DeployEvents = Data.taggedEnum<DeployEvent>();

/** The one legal-transition function. Anything else is a programming error,
 * not a runtime condition, so it throws instead of silently skipping a step. */
export const advanceDeploy = (
  phase: DeployPhase,
  event: DeployEvent
): DeployPhase => {
  if (phase._tag === "Prepared" && event._tag === "Staged") {
    return DeployPhases.Staged();
  }

  if (phase._tag === "Staged" && event._tag === "Pushed") {
    return DeployPhases.Pushed();
  }

  if (phase._tag === "Pushed" && event._tag === "Recorded") {
    return DeployPhases.Recorded();
  }

  if (phase._tag === "Recorded" && event._tag === "Reported") {
    return DeployPhases.Reported({ comment: event.comment });
  }

  throw new Error(`illegal deploy transition: ${phase._tag} + ${event._tag}`);
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
      let phase: DeployPhase = DeployPhases.Prepared();

      const commentMode = parseCommentMode(config.comment);

      if (commentMode === null) {
        return yield* Effect.fail("--comment must be update, create, or off");
      }

      const context = yield* readActionContext();

      const repo = context._tag === "Actions" ? context.repo : null;

      const sha = context._tag === "Actions" ? context.sha : null;

      const outputFile = context._tag === "Actions" ? context.outputFile : null;

      const prNumber =
        context._tag === "Actions" && context.target._tag === "PullRequest"
          ? context.target.number
          : null;

      const conn = yield* connection(config, repo);
      const resolvedSlug = conn.slug;

      if (["app", "api", "git"].includes(resolvedSlug)) {
        return yield* Effect.fail(
          `slug ${resolvedSlug} is reserved (app/api/git)`
        );
      }

      const { gitBase, token } = conn;
      const remoteUrl = remoteUrlOf(gitBase, resolvedSlug);

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
        config.message === "" ? defaultMessage(sha) : config.message;

      // The staging dir is removed on success; on failure it is kept and
      // warned about (`withTempDir`) for post-mortem.
      const pushedSha = yield* withTempDir((staging) =>
        Effect.gen(function* stage() {
          yield* stageDist(distDir, staging, config.wrangler);
          phase = advanceDeploy(phase, DeployEvents.Staged());

          return yield* pushTree({
            message,
            remoteUrl,
            token,
            treeDir: staging,
          });
        })
      );

      phase = advanceDeploy(phase, DeployEvents.Pushed());

      // The push is irreversible: record its result first, so nothing after
      // a live deploy can leave a later step reporting it as failed.
      yield* writeOutputs({ outputFile, sha: pushedSha, url });
      phase = advanceDeploy(phase, DeployEvents.Recorded());

      yield* Effect.logInfo(
        `deployed ${resolvedSlug}@${pushedSha.slice(0, 12)} → ${url}`
      );

      const comment = yield* commentPr({
        body: `🚀 Deploy \`${pushedSha.slice(0, 12)}\` live → ${url}`,
        mode: commentMode,
        prNumber,
        repo,
      });

      phase = advanceDeploy(phase, DeployEvents.Reported({ comment }));
    })
).pipe(
  Command.withDescription(
    "Deploy a prebuilt dist directory over Git smart-HTTP"
  )
);
