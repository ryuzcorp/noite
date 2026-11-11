/** `noite environments` — an app's preview environments, over the control UI's
 * MCP tools (see `mcp.ts` for why that, and `config.ts` for the connection
 * flags). Every command is a thin client: the printing, the role gates and the
 * wording come from the same tools an agent calls, so the two can never
 * disagree about what an environment is. */
import { Argument, Command, Flag } from "effect/cli";

import { connFlags, runTool } from "./connect.js";
import type { ConnFlags } from "./connect.js";
import type { ToolArgs } from "./mcp.js";

const list = Command.make(
  "list",
  connFlags,
  runTool("list_environments", () => ({}))
).pipe(Command.withDescription("List an app's preview environments"));

const create = Command.make(
  "create",
  {
    ...connFlags,
    branch: Flag.String("branch").pipe(
      Flag.withDescription(
        "Branch to deploy (not main; the environment's label follows it)"
      )
    ),
  },
  runTool<ConnFlags & { branch: string }>("create_environment", (flags) => ({
    branch: flags.branch,
  }))
).pipe(Command.withDescription("Create an environment from a branch"));

const remove = Command.make(
  "delete",
  { ...connFlags, environment: Argument.String("environment") },
  runTool<ConnFlags & { environment: string }>(
    "delete_environment",
    (flags) => ({
      environment: flags.environment,
    })
  )
).pipe(
  Command.withDescription(
    "Delete an environment (label or id) and everything it owns"
  )
);

const redeploy = Command.make(
  "deploy",
  { ...connFlags, environment: Argument.String("environment") },
  runTool<ConnFlags & { environment: string }>(
    "deploy_environment",
    (flags) => ({
      environment: flags.environment,
    })
  )
).pipe(
  Command.withDescription("Re-deploy an environment at its branch's head")
);

const toggle = Command.make(
  "public",
  {
    ...connFlags,
    environment: Argument.String("environment"),
    state: Argument.Literals("state", ["on", "off"]).pipe(
      Argument.withDescription("on = anyone with the URL, off = members only")
    ),
  },
  runTool<ConnFlags & { environment: string; state: string }>(
    "set_environment_public",
    (flags) => ({
      environment: flags.environment,
      public: flags.state === "on",
    })
  )
).pipe(
  Command.withDescription("Make an environment public, or members-only again")
);

/** Argument mapping for `vars get/set/unset`, exported for tests: the MCP
 * tools take `key`, the CLI spells it `name`. */
export const varsGetArgs = (flags: {
  readonly environment: string;
}): ToolArgs => ({ environment: flags.environment });

export const varsSetArgs = (flags: {
  readonly environment: string;
  readonly name: string;
  readonly value: string;
}): ToolArgs => ({
  environment: flags.environment,
  key: flags.name,
  value: flags.value,
});

export const varsUnsetArgs = (flags: {
  readonly environment: string;
  readonly name: string;
}): ToolArgs => ({ environment: flags.environment, key: flags.name });

const varsGet = Command.make(
  "get",
  { ...connFlags, environment: Argument.String("environment") },
  runTool<ConnFlags & { environment: string }>(
    "environment_env_list",
    varsGetArgs
  )
).pipe(Command.withDescription("List an environment's variable overrides"));

const varsSet = Command.make(
  "set",
  {
    ...connFlags,
    environment: Argument.String("environment"),
    name: Argument.String("name"),
    value: Argument.String("value"),
  },
  runTool<ConnFlags & { environment: string; name: string; value: string }>(
    "environment_env_set",
    varsSetArgs
  )
).pipe(Command.withDescription("Set one variable override for an environment"));

const varsUnset = Command.make(
  "unset",
  {
    ...connFlags,
    environment: Argument.String("environment"),
    name: Argument.String("name"),
  },
  runTool<ConnFlags & { environment: string; name: string }>(
    "environment_env_unset",
    varsUnsetArgs
  )
).pipe(
  Command.withDescription(
    "Remove one variable override, falling back to the app's value"
  )
);

const vars = Command.make("vars").pipe(
  Command.withDescription(
    "An environment's variable overrides (the app's variables are inherited)"
  ),
  Command.withSubcommands([varsGet, varsSet, varsUnset])
);

export const environments = Command.make("environments").pipe(
  Command.withDescription(
    "Preview environments: one per branch or workspace, each on its own host with its own storage"
  ),
  Command.withSubcommands([list, create, remove, redeploy, toggle, vars])
);
