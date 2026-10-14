/** `noite environments` — an app's preview environments, over the control UI's
 * MCP tools (see `mcp.ts` for why that, and `config.ts` for the connection
 * flags). Every command is a thin client: the printing, the role gates and the
 * wording come from the same tools an agent calls, so the two can never
 * disagree about what an environment is. */
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { connection } from "./config.js";
import type { Connection } from "./config.js";
import { readActionContext } from "./gh.js";
import { callTool } from "./mcp.js";
import type { ToolArgs } from "./mcp.js";

/** The connection flags every command carries; the descriptions are the
 * reference's own table. */
const connFlags = {
  appUrl: Flag.String("app-url").pipe(
    Flag.withDescription(
      "Control UI origin (default: derived from --url, or NOITE_APP_URL)"
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
};

/** One line to stdout — a command's output, not a log. Effect's own logger
 * writes to stderr with a level prefix, which reads as noise in CI. */
const print = (line: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    process.stdout.write(`${line}\n`);
  });

interface ConnFlags {
  readonly appUrl: string;
  readonly slug: string;
  readonly token: string;
  readonly url: string;
}

/** Run one MCP tool as `--slug`'s app and print what it answered. `argsOf`
 * maps the parsed flags onto that tool's arguments; the app slug is added
 * here, from the same resolution every other command uses. */
const run =
  <Flags extends ConnFlags>(
    name: string,
    argsOf: (flags: Flags) => ToolArgs
  ): ((flags: Flags) => Effect.Effect<void, Error | string, never>) =>
  (flags: Flags): Effect.Effect<void, Error | string, never> =>
    Effect.gen(function* tool() {
      const ctx = yield* readActionContext();
      const conn: Connection = yield* connection(flags, ctx.repo);
      const result = yield* callTool<unknown>(conn, name, {
        app: conn.slug,
        ...argsOf(flags),
      });
      yield* print(result.text);
    });

const list = Command.make(
  "list",
  connFlags,
  run("list_environments", () => ({}))
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
  run<ConnFlags & { branch: string }>("create_environment", (flags) => ({
    branch: flags.branch,
  }))
).pipe(Command.withDescription("Create an environment from a branch"));

const remove = Command.make(
  "delete",
  { ...connFlags, environment: Argument.String("environment") },
  run<ConnFlags & { environment: string }>("delete_environment", (flags) => ({
    environment: flags.environment,
  }))
).pipe(
  Command.withDescription(
    "Delete an environment (label or id) and everything it owns"
  )
);

const redeploy = Command.make(
  "deploy",
  { ...connFlags, environment: Argument.String("environment") },
  run<ConnFlags & { environment: string }>("deploy_environment", (flags) => ({
    environment: flags.environment,
  }))
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
  run<ConnFlags & { environment: string; state: string }>(
    "set_environment_public",
    (flags) => ({
      environment: flags.environment,
      public: flags.state === "on",
    })
  )
).pipe(
  Command.withDescription("Make an environment public, or members-only again")
);

const varsGet = Command.make(
  "get",
  { ...connFlags, environment: Argument.String("environment") },
  run<ConnFlags & { environment: string }>("environment_env_list", (flags) => ({
    environment: flags.environment,
  }))
).pipe(Command.withDescription("List an environment's variable overrides"));

const varsSet = Command.make(
  "set",
  {
    ...connFlags,
    environment: Argument.String("environment"),
    name: Argument.String("name"),
    value: Argument.String("value"),
  },
  run<ConnFlags & { environment: string; name: string; value: string }>(
    "environment_env_set",
    (flags) => ({
      environment: flags.environment,
      key: flags.name,
      value: flags.value,
    })
  )
).pipe(Command.withDescription("Set one variable override for an environment"));

const vars = Command.make("vars").pipe(
  Command.withDescription(
    "An environment's variable overrides (the app's variables are inherited)"
  ),
  Command.withSubcommands([varsGet, varsSet])
);

export const environments = Command.make("environments").pipe(
  Command.withDescription(
    "Preview environments: one per branch or workspace, each on its own host with its own storage"
  ),
  Command.withSubcommands([list, create, remove, redeploy, toggle, vars])
);
