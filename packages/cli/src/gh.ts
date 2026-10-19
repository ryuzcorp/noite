import { appendFile, readFile } from "node:fs/promises";

import { Effect } from "effect";
import * as Schema from "effect/Schema";

import { runProc } from "./proc.js";

export interface ActionContext {
  readonly isActions: boolean;
  readonly repo: string | null;
  readonly sha: string | null;
  readonly refName: string | null;
  readonly runId: string | null;
  readonly outputFile: string | null;
  readonly prNumber: number | null;
}

/** GitHub event payload: only the PR number is read, everything else ignored. */
const EventPayload = Schema.Struct({
  pull_request: Schema.optional(Schema.Struct({ number: Schema.Number })),
});

/** PR comment rows as the gh API returns them. */
const GhApiComments = Schema.Array(
  Schema.Struct({ body: Schema.String, id: Schema.Number })
);

const nonEmpty = (value: string | undefined): string | null =>
  value !== undefined && value !== "" ? value : null;
export const readActionContext = (): Effect.Effect<ActionContext, never> =>
  Effect.gen(function* run() {
    const { env } = process;
    if (env.GITHUB_ACTIONS !== "true") {
      return {
        isActions: false,
        outputFile: null,
        prNumber: null,
        refName: null,
        repo: null,
        runId: null,
        sha: null,
      } satisfies ActionContext;
    }
    let prNumber: number | null = null;
    const eventPath = env.GITHUB_EVENT_PATH;
    if (eventPath !== undefined && eventPath !== "") {
      const eventText = yield* Effect.promise(() =>
        readFile(eventPath, "utf-8").catch(() => null)
      );
      if (eventText !== null) {
        try {
          prNumber =
            Schema.decodeUnknownSync(EventPayload)(JSON.parse(eventText))
              .pull_request?.number ?? null;
        } catch {
          prNumber = null;
        }
      }
    }
    return {
      isActions: true,
      outputFile: nonEmpty(env.GITHUB_OUTPUT),
      prNumber,
      refName: nonEmpty(env.GITHUB_REF_NAME),
      repo: nonEmpty(env.GITHUB_REPOSITORY),
      runId: nonEmpty(env.GITHUB_RUN_ID),
      sha: nonEmpty(env.GITHUB_SHA),
    } satisfies ActionContext;
  });

/** Append `url=` + `sha=` for downstream steps. No-op outside Actions. */
export const writeOutputs = (args: {
  readonly outputFile: string | null;
  readonly sha: string;
  readonly url: string;
}): Effect.Effect<void, Error> =>
  args.outputFile === null
    ? Effect.void
    : Effect.tryPromise({
        catch: () => new Error("writing $GITHUB_OUTPUT failed"),
        try: async (): Promise<void> => {
          // SAFETY: outputFile is null-checked by the outer ternary; inside tryPromise it stays a non-empty string.
          await appendFile(
            args.outputFile as string,
            `url=${args.url}\nsha=${args.sha}\n`
          );
        },
      });

export const COMMENT_MARKER = "<!-- noite-deploy -->";

export type CommentMode = "update" | "create" | "off";

export const parseCommentMode = (raw: string): CommentMode | null =>
  raw === "update" || raw === "create" || raw === "off" ? raw : null;

interface GhComment {
  readonly id: number;
  readonly body: string;
}

/** Post (or update, via marker) the deploy PR comment. Soft-fails: a
 * missing `gh`, missing token, or no PR number only warns — the deploy
 * already succeeded. */
export const commentPr = (args: {
  readonly mode: CommentMode;
  readonly repo: string | null;
  readonly prNumber: number | null;
  readonly body: string;
}): Effect.Effect<void, never> =>
  Effect.gen(function* run() {
    if (args.mode === "off" || args.repo === null || args.prNumber === null) {
      return;
    }
    const fullBody = `${args.body}\n\n${COMMENT_MARKER}`;
    // SAFETY: the early return above guarantees repo is a non-null string here.
    const repo = args.repo as string;
    const comment = [
      "pr",
      "comment",
      String(args.prNumber),
      "--repo",
      repo,
      "--body",
      fullBody,
    ];
    yield* Effect.gen(function* post() {
      if (args.mode === "create") {
        yield* runProc("gh", comment);
        return;
      }
      const listed = yield* runProc("gh", [
        "api",
        `repos/${repo}/issues/${args.prNumber}/comments`,
        "--paginate",
      ]);
      if (listed.code !== 0) {
        return yield* Effect.fail(new Error("listing PR comments failed"));
      }
      let comments: readonly GhComment[];
      try {
        comments = Schema.decodeUnknownSync(GhApiComments)(
          JSON.parse(listed.stdout)
        );
      } catch {
        return yield* Effect.fail(
          new Error("listing PR comments returned invalid JSON")
        );
      }
      const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
      yield* runProc(
        "gh",
        existing === undefined
          ? comment
          : [
              "api",
              `repos/${repo}/issues/comments/${existing.id}`,
              "-X",
              "PATCH",
              "-f",
              `body=${fullBody}`,
            ]
      );
    }).pipe(
      Effect.mapError(() => new Error("pr comment failed")),
      Effect.tapError((cause) =>
        Effect.sync(() =>
          console.warn(`warning: ${cause.message} (deploy unaffected)`)
        )
      ),
      Effect.ignore
    );
  });
