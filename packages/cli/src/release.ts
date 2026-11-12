/** `noite rollback` and `noite logs` — the deploy lifecycle around a push,
 * over the control UI's MCP tools. Thin clients, like `pr` and
 * `environments`: `rollback` runs a previous successful sha again,
 * `logs` prints the app's (or a preview environment's) recent lines. */
import { Command, Flag } from "effect/cli";

import { connFlags, runTool } from "./connect.js";
import type { ConnFlags } from "./connect.js";
import type { ToolArgs } from "./mcp.js";

export const rollbackArgs = (flags: {
  readonly environment: string;
  readonly sha: string;
}): ToolArgs => ({
  environment: flags.environment === "" ? undefined : flags.environment,
  sha: flags.sha,
});

export const logsArgs = (flags: {
  readonly environment: string;
  readonly limit: string;
}): ToolArgs => ({
  environment: flags.environment === "" ? undefined : flags.environment,
  limit: flags.limit === "" ? undefined : Number(flags.limit),
});

export const rollback = Command.make(
  "rollback",
  {
    ...connFlags,
    environment: Flag.String("environment").pipe(
      Flag.withDescription(
        "Preview environment label or id (default: production)"
      ),
      Flag.withDefault("")
    ),
    sha: Flag.String("sha").pipe(
      Flag.withDescription(
        "The commit sha to run again (a deploy_status row shows one)"
      )
    ),
  },
  runTool<ConnFlags & { environment: string; sha: string }>(
    "rollback",
    rollbackArgs
  )
).pipe(
  Command.withDescription(
    "Re-run a previous successful deploy of this app (production, or one environment)"
  )
);

export const logs = Command.make(
  "logs",
  {
    ...connFlags,
    environment: Flag.String("environment").pipe(
      Flag.withDescription(
        "Preview environment label or id (default: production)"
      ),
      Flag.withDefault("")
    ),
    limit: Flag.String("limit").pipe(
      Flag.withDescription("How many trailing lines (default 200)"),
      Flag.withDefault("")
    ),
  },
  runTool<ConnFlags & { environment: string; limit: string }>(
    "app_logs",
    logsArgs
  )
).pipe(Command.withDescription("Print the app's recent runtime log lines"));
