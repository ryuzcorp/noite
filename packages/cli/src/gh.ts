import { appendFile, readFile } from "node:fs/promises";

import { Data, Effect } from "effect";
import * as Schema from "effect/Schema";

import { runProc } from "./proc.js";
import type { ProcResult, RunProc } from "./proc.js";

/** What kind of run this is: outside Actions there is no repo/sha/output file;
 * inside Actions the event payload decides between a PR, a branch push and a
 * payload the CLI cannot read (which used to be indistinguishable from a
 * branch push — both skipped the PR comment silently).
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Local: GITHUB_ACTIONS != true
 *   [*] --> Actions: GITHUB_ACTIONS == true
 *   Actions --> PullRequest: event has pull_request.number
 *   Actions --> Branch: event is readable, no pull_request
 *   Actions --> Unknown: event path missing/unreadable/invalid JSON
 * ```
 */
export type CiTarget = Data.TaggedEnum<{
  Branch: { readonly name: string | null };
  PullRequest: { readonly number: number };
  Unknown: { readonly reason: string };
}>;

const { Branch, PullRequest, Unknown } = Data.taggedEnum<CiTarget>();

/** The Actions context, as one closed type. Only Actions can expose a repo,
 * sha or output file; the PR/chance distinction lives in `target`. */
export type ActionContext = Data.TaggedEnum<{
  Actions: {
    readonly outputFile: string | null;
    readonly repo: string | null;
    readonly sha: string | null;
    readonly target: CiTarget;
  };
  Local: Record<never, never>;
}>;

const { Actions, Local } = Data.taggedEnum<ActionContext>();

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

/** Classify one event payload, once. A missing/unreadable/malformed payload
 * is `Unknown`; a readable payload without a PR is a branch push. */
const targetOf = (
  eventPath: string | null,
  eventText: string | null
): CiTarget => {
  if (eventPath === null) {
    return Unknown({ reason: "GITHUB_EVENT_PATH is not set" });
  }

  if (eventText === null) {
    return Unknown({ reason: `cannot read ${eventPath}` });
  }

  try {
    const payload = Schema.decodeUnknownSync(EventPayload)(
      JSON.parse(eventText)
    );

    const number = payload.pull_request?.number;

    return number === undefined
      ? Branch({ name: nonEmpty(process.env.GITHUB_REF_NAME) })
      : PullRequest({ number });
  } catch {
    return Unknown({ reason: `cannot parse ${eventPath}` });
  }
};

export const readActionContext = (): Effect.Effect<ActionContext, never> =>
  Effect.gen(function* run() {
    const { env } = process;

    if (env.GITHUB_ACTIONS !== "true") {
      return Local();
    }

    const eventPath = nonEmpty(env.GITHUB_EVENT_PATH);

    const eventText =
      eventPath === null
        ? null
        : yield* Effect.promise(() =>
            readFile(eventPath, "utf-8").catch(() => null)
          );

    return Actions({
      outputFile: nonEmpty(env.GITHUB_OUTPUT),
      repo: nonEmpty(env.GITHUB_REPOSITORY),
      sha: nonEmpty(env.GITHUB_SHA),
      target: targetOf(eventPath, eventText),
    });
  });

/** Append `url=` + `sha=` for downstream steps. No-op outside Actions.
 * Soft-fails: the push already landed (a live deploy cannot be undone), so a
 * disk-full or malformed `$GITHUB_OUTPUT` warns instead of failing the step. */
export const writeOutputs = (args: {
  readonly outputFile: string | null;
  readonly sha: string;
  readonly url: string;
}): Effect.Effect<void, never> =>
  args.outputFile === null
    ? Effect.void
    : Effect.tryPromise({
        catch: (cause) =>
          new Error(`writing $GITHUB_OUTPUT failed: ${String(cause)}`),
        try: async (): Promise<void> => {
          // SAFETY: outputFile is null-checked by the outer ternary; inside tryPromise it stays a non-empty string.
          await appendFile(
            args.outputFile as string,
            `url=${args.url}\nsha=${args.sha}\n`
          );
        },
      }).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() =>
            console.warn(`warning: ${cause.message} (deploy is live)`)
          )
        ),
        Effect.ignore
      );

export const COMMENT_MARKER = "<!-- noite-deploy -->";

export type CommentMode = "update" | "create" | "off";

export const parseCommentMode = (raw: string): CommentMode | null =>
  raw === "update" || raw === "create" || raw === "off" ? raw : null;

/** What happened to the deploy comment. `Failed` still lets the deploy pass;
 * the warning names the failing `gh` exit.
 *
 * | From | Event | To |
 * | --- | --- | --- |
 * | any | `mode = off` | `Off` |
 * | any | no repo / no PR | `Skipped` |
 * | create | `gh` exit 0 | `Posted` |
 * | update | marker absent, `gh` exit 0 | `Posted` |
 * | update | marker present, `gh` exit 0 | `Updated{id}` |
 * | any | `gh` non-zero / unreadable list | `Failed{reason}` | */
export type CommentOutcome = Data.TaggedEnum<{
  Failed: { readonly reason: string };
  Off: Record<never, never>;
  Posted: Record<never, never>;
  Skipped: { readonly why: "no-pr" | "no-repo" };
  Updated: { readonly id: number };
}>;

const { Failed, Off, Posted, Skipped, Updated } =
  Data.taggedEnum<CommentOutcome>();

interface GhComment {
  readonly id: number;
  readonly body: string;
}

/** A `gh` call that exited non-zero is a refusal even though `runProc`
 * resolves it: name the exit and its stderr so the warning is actionable. */
const ghExit = (what: string, proc: ProcResult): string =>
  `gh ${what} exited ${proc.code}${
    proc.stderr === "" ? "" : `: ${proc.stderr}`
  }`;

/** Post (or update, via marker) the deploy PR comment. Soft-fails: a missing
 * `gh`, missing token, non-zero exit or no PR number only warns — the deploy
 * already succeeded. Every branch is reported through `CommentOutcome`. */
export const commentPr = (
  args: {
    readonly body: string;
    readonly mode: CommentMode;
    readonly prNumber: number | null;
    readonly repo: string | null;
  },
  run: RunProc = runProc
): Effect.Effect<CommentOutcome, never> => {
  if (args.mode === "off") {
    return Effect.succeed(Off());
  }

  if (args.repo === null) {
    return Effect.succeed(Skipped({ why: "no-repo" }));
  }

  if (args.prNumber === null) {
    return Effect.succeed(Skipped({ why: "no-pr" }));
  }

  const fullBody = `${args.body}\n\n${COMMENT_MARKER}`;
  const { prNumber, repo } = args;

  const comment = [
    "pr",
    "comment",
    String(prNumber),
    "--repo",
    repo,
    "--body",
    fullBody,
  ];

  const post = Effect.gen(function* postComment() {
    if (args.mode === "create") {
      const written = yield* run("gh", comment);

      if (written.code !== 0) {
        return yield* Effect.fail(new Error(ghExit("comment create", written)));
      }

      return Posted();
    }

    const listed = yield* run("gh", [
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--paginate",
    ]);

    if (listed.code !== 0) {
      return yield* Effect.fail(
        new Error(ghExit("listing PR comments", listed))
      );
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

    const written = yield* run(
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

    if (written.code !== 0) {
      return yield* Effect.fail(
        new Error(
          ghExit(
            existing === undefined
              ? "comment create"
              : `comment ${existing.id} update`,
            written
          )
        )
      );
    }

    return existing === undefined ? Posted() : Updated({ id: existing.id });
  });

  return post.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() =>
        console.warn(
          `warning: pr comment failed: ${cause.message} (deploy unaffected)`
        )
      )
    ),
    Effect.orElseSucceed((cause) => Failed({ reason: cause.message }))
  );
};
