import { Effect } from "effect";
import * as Schema from "effect/Schema";

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
      const parsed: unknown = yield* Effect.promise(() =>
        Bun.file(eventPath)
          .json()
          .catch(() => null)
      );
      try {
        prNumber =
          Schema.decodeUnknownSync(EventPayload)(parsed).pull_request?.number ??
          null;
      } catch {
        prNumber = null;
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
          const file = Bun.file(args.outputFile as string);
          const prev = (await file.exists()) ? await file.text() : "";
          await Bun.write(
            // SAFETY: same null-check as above; the closure cannot observe a reassignment.
            args.outputFile as string,
            `${prev}url=${args.url}\nsha=${args.sha}\n`
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
    yield* Effect.tryPromise({
      catch: () => new Error("pr comment failed"),
      try: async (): Promise<void> => {
        if (args.mode === "create") {
          await Bun.spawn([
            "gh",
            "pr",
            "comment",
            String(args.prNumber),
            "--repo",
            // SAFETY: early return above guarantees repo is a non-null string here.
            args.repo as string,
            "--body",
            fullBody,
          ]).exited;
          return;
        }
        const proc = Bun.spawn(
          [
            "gh",
            "api",
            `repos/${args.repo}/issues/${args.prNumber}/comments`,
            "--paginate",
          ],
          { stderr: "pipe", stdout: "pipe" }
        );
        const [out, code] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        if (code !== 0) {
          throw new Error("listing PR comments failed");
        }
        let comments: readonly GhComment[];
        try {
          comments = Schema.decodeUnknownSync(GhApiComments)(JSON.parse(out));
        } catch {
          throw new Error("listing PR comments returned invalid JSON");
        }
        const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
        void (existing === undefined
          ? await Bun.spawn([
              "gh",
              "pr",
              "comment",
              String(args.prNumber),
              "--repo",
              // SAFETY: early return above guarantees repo is a non-null string here.
              args.repo as string,
              "--body",
              fullBody,
            ]).exited
          : await Bun.spawn([
              "gh",
              "api",
              `repos/${args.repo}/issues/comments/${existing.id}`,
              "-X",
              "PATCH",
              "-f",
              `body=${fullBody}`,
            ]).exited);
      },
    }).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() =>
          console.warn(`warning: ${cause.message} (deploy unaffected)`)
        )
      ),
      Effect.ignore
    );
  });
