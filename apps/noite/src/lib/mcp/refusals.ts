/**
 * The refusals an agent can act on (the agent loop). A tool that writes can be
 * turned down for a reason the caller can fix — a protected branch, a tip that
 * moved under it, a pull request that will not merge, a role it does not hold —
 * and each reason is one closed code with one hint. The result keeps
 * `isError: true` (the MCP spec's tool-execution error) and carries the code as
 * `structuredContent.refusal`, so a client branches on `code` instead of
 * parsing English.
 *
 * `refusalOf` is the only classifier. The runner has no sub-codes on its
 * refusals yet, so it maps the HTTP status plus the runner's own vocabulary;
 * every new refusal that must be acted on adds a row here and a case in
 * `refusals.test.ts`.
 */
import { runnerFailureOf } from "../runner";
import { McpToolError } from "./protocol";
import type { ToolRefusal } from "./protocol";

/** Why a write was refused, in the terms a caller can change. */
export type RefusalCode =
  | "branch_exists"
  | "branch_missing"
  | "conflict"
  | "forbidden"
  | "invalid"
  | "no_deploy"
  | "not_found"
  | "not_mergeable"
  | "not_open"
  | "protected_branch"
  | "stale_tip"
  | "too_many_waits";

/** What to do next, per code. One sentence each: the code says what happened,
 * the hint says the next call. */
const HINTS: Record<RefusalCode, string> = {
  branch_exists:
    "Commit to the branch that exists (commit_files), or pick another name.",
  branch_missing:
    "List the branches with repo_branches, then retry against one it shows.",
  conflict:
    "Read the message, fix what it names, and retry; the runner wrote nothing.",
  forbidden:
    "This account's role on the app does not allow it — ask an app admin for a stronger role (view < push < admin).",
  invalid:
    "Fix the arguments the message names and retry; the runner rejected the request before writing.",
  no_deploy:
    "Nothing has deployed yet — push or commit first, and read deploy_status.",
  not_found:
    "Check the identifier: list_prs and repo_branches list what exists.",
  not_mergeable:
    "Resolve what the message names (conflicts, approvals or the missing branch), then read get_pr again before merging.",
  not_open:
    "The pull request already closed or merged; list_prs shows its state.",
  protected_branch:
    "Commit to a new branch and open a pull request; main only takes merges while branch protection is on.",
  stale_tip:
    "Read the branch tip again (repo_branches), then retry with the new tip as expectedTip.",
  too_many_waits:
    "Wait for one of the calls already in flight to answer, then re-arm this one.",
};

/** One refusal, as it travels: `code` is the closed reason, `message` and
 * `hint` are what a caller reads. */
export const refusalResult = (
  code: RefusalCode,
  message: string
): ToolRefusal => ({ code, hint: HINTS[code], message });

/** Build the tool error that carries one refusal. */
export const refused = (code: RefusalCode, message: string): McpToolError =>
  new McpToolError(message, { refusal: refusalResult(code, message) });

/** The runner's 409 vocabulary → the code to act on. First match wins, so a
 * more specific phrase precedes the general one it contains. */
const CONFLICTS: readonly (readonly [RegExp, RefusalCode])[] = [
  [/tip moved/u, "stale_tip"],
  [
    /is protected|protected ref|cannot delete the default branch/u,
    "protected_branch",
  ],
  [
    /not open|is (?:closed|merged) and cannot be merged|not in flight|point of no return/u,
    "not_open",
  ],
  [
    /merge conflicts|approving review|head branch|head .* is gone|base branch .* is gone/u,
    "not_mergeable",
  ],
  [/already exists/u, "branch_exists"],
];

/** A 404 whose subject is a branch (git's own "not found" wording). */
const BRANCH_NOT_FOUND = /branch .*not found|invalid ref|unknown ref/u;

/** Classify one caught error as a refusal. Anything that is already an
 * `McpToolError` (the role gate, a tool's own refusal) passes through
 * unchanged; a runner failure is read by status and vocabulary; anything else
 * is not a refusal and the caller rethrows it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site classifier: the thrown value is unknown by construction, and this is the place it becomes a domain type.
export const refusalOf = (error: unknown): McpToolError | null => {
  if (error instanceof McpToolError) {
    return error;
  }

  const failure = runnerFailureOf(error);

  if (failure.kind === "http") {
    const { message, status } = failure;

    if (status === 409) {
      const match = CONFLICTS.find(([pattern]) => pattern.test(message));

      return refused(match?.[1] ?? "conflict", message);
    }

    if (status === 404) {
      return refused(
        BRANCH_NOT_FOUND.test(message) ? "branch_missing" : "not_found",
        message
      );
    }

    if (status === 403) {
      return refused("forbidden", message);
    }

    if (status === 400) {
      // A rejected argument: the caller can fix what it sent (a bad ref, path
      // or body).
      return refused("invalid", message);
    }

    return null;
  }

  return null;
};

/** Run one runner mutation and never let a refusal through as a 500-shaped
 * error: the agent reads a code it can branch on. A failure that is not a
 * refusal keeps its own message. */
export const attempt = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalOf(error) ?? error;
  }
};

/** Run one gate helper (`requireApp`, `requireEnvironment`) that answers a
 * denial as a bare `McpToolError`, and give that denial the code an agent can
 * act on. The helper owns the decision and the wording — the code is the only
 * thing added here — so `forbidden` and `not_found` cannot drift from it. */
export const denyAs = async <T>(
  work: () => Promise<T>,
  code: RefusalCode
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof McpToolError &&
      error.refusal === null &&
      !error.invalid
    ) {
      throw refused(code, error.message);
    }

    throw error;
  }
};
