/** `noite pr` — pull requests over the control UI's MCP tools, as a thin
 * client: the role gates, the merge rules and the wording are the tools' own
 * (`list_prs`, `get_pr`, `create_pr`, `merge_pr`), so the CLI and an agent
 * see one product. */
import { Argument, Command, Flag } from "effect/cli";

import { connFlags, runTool } from "./connect.js";
import type { ConnFlags } from "./connect.js";
import type { ToolArgs } from "./mcp.js";

/** `pr list --state` / `--limit` as the tool's arguments. Exported for the
 * CLI's argument-mapping test. */
export const prListArgs = (flags: {
  readonly limit: string;
  readonly state: string;
}): ToolArgs => ({
  limit: flags.limit === "" ? undefined : Number(flags.limit),
  state: flags.state === "" ? undefined : flags.state,
});

export const prViewArgs = (flags: { readonly number: string }): ToolArgs => ({
  number: Number(flags.number),
});

export const prCreateArgs = (flags: {
  readonly base: string;
  readonly body: string;
  readonly head: string;
  readonly title: string;
}): ToolArgs => ({
  base: flags.base === "" ? undefined : flags.base,
  body: flags.body === "" ? undefined : flags.body,
  head: flags.head,
  title: flags.title,
});

export const prMergeArgs = (flags: {
  readonly deleteBranch: boolean;
  readonly message: string;
  readonly number: string;
  readonly title: string;
}): ToolArgs => ({
  deleteBranch: flags.deleteBranch,
  message: flags.message === "" ? undefined : flags.message,
  number: Number(flags.number),
  title: flags.title === "" ? undefined : flags.title,
});

const list = Command.make(
  "list",
  {
    ...connFlags,
    limit: Flag.String("limit").pipe(
      Flag.withDescription("How many to return (default 30)"),
      Flag.withDefault("")
    ),
    state: Flag.String("state").pipe(
      Flag.withDescription("open, closed, merged or all (default all)"),
      Flag.withDefault("")
    ),
  },
  runTool<ConnFlags & { limit: string; state: string }>("list_prs", prListArgs)
).pipe(Command.withDescription("List this app's pull requests"));

const view = Command.make(
  "view",
  { ...connFlags, number: Argument.String("number") },
  runTool<ConnFlags & { number: string }>("get_pr", prViewArgs)
).pipe(
  Command.withDescription(
    "One pull request: state, mergeability, reviews and the checks that gate merging"
  )
);

const create = Command.make(
  "create",
  {
    ...connFlags,
    base: Flag.String("base").pipe(
      Flag.withDescription(
        "Branch to merge into (default: the default branch)"
      ),
      Flag.withDefault("")
    ),
    body: Flag.String("body").pipe(
      Flag.withDescription("Description (Markdown)"),
      Flag.withDefault("")
    ),
    head: Flag.String("head").pipe(
      Flag.withDescription("Branch with the changes")
    ),
    title: Flag.String("title").pipe(Flag.withDescription("Title")),
  },
  runTool<
    ConnFlags & { base: string; body: string; head: string; title: string }
  >("create_pr", prCreateArgs)
).pipe(Command.withDescription("Open a pull request (needs the push role)"));

const merge = Command.make(
  "merge",
  {
    ...connFlags,
    deleteBranch: Flag.Boolean("delete-branch").pipe(
      Flag.withDescription("Delete the head branch after merging"),
      Flag.withDefault(false)
    ),
    message: Flag.String("message").pipe(
      Flag.withDescription(
        "Merge commit body (default: the branch's subjects)"
      ),
      Flag.withDefault("")
    ),
    number: Argument.String("number"),
    title: Flag.String("title").pipe(
      Flag.withDescription("Merge commit title (default: the pull request's)"),
      Flag.withDefault("")
    ),
  },
  runTool<
    ConnFlags & {
      deleteBranch: boolean;
      message: string;
      number: string;
      title: string;
    }
  >("merge_pr", prMergeArgs)
).pipe(
  Command.withDescription(
    "Squash-merge a pull request (branch protection enforced)"
  )
);

export const pr = Command.make("pr").pipe(
  Command.withDescription(
    "Pull requests: list, view, create and merge from the terminal"
  ),
  Command.withSubcommands([list, view, create, merge])
);
