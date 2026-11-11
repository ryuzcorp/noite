/** What every MCP-backed command shares: the four connection flags, one line
 * to stdout, and the one way a command calls a tool.
 *
 * Commands are thin clients of the control UI's MCP tools (see `mcp.ts` for
 * why that): the printing, the role gates and the wording come from the same
 * tools an agent calls, so the two can never disagree about what a pull
 * request or a deploy is. */
import { Effect } from "effect";
import { Flag } from "effect/cli";

import { connection } from "./config.js";
import type { Connection } from "./config.js";
import { readActionContext } from "./gh.js";
import { callTool } from "./mcp.js";
import type { ToolArgs } from "./mcp.js";

/** The connection flags every command carries; the descriptions are the
 * reference's own table. */
export const connFlags = {
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

export interface ConnFlags {
  readonly appUrl: string;
  readonly slug: string;
  readonly token: string;
  readonly url: string;
}

/** One line to stdout — a command's output, not a log. Effect's own logger
 * writes to stderr with a level prefix, which reads as noise in CI. */
export const print = (line: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    process.stdout.write(`${line}\n`);
  });

/** Run one MCP tool as `--slug`'s app and print what it answered. `argsOf`
 * maps the parsed flags onto that tool's arguments; the app slug is added
 * here, from the same resolution every other command uses. */
export const runTool =
  <Flags extends ConnFlags>(
    name: string,
    argsOf: (flags: Flags) => ToolArgs
  ): ((flags: Flags) => Effect.Effect<void, Error | string, never>) =>
  (flags: Flags): Effect.Effect<void, Error | string, never> =>
    Effect.gen(function* tool() {
      const ctx = yield* readActionContext();
      const repo = ctx._tag === "Actions" ? ctx.repo : null;
      const conn: Connection = yield* connection(flags, repo);

      const result = yield* callTool<unknown>(conn, name, {
        app: conn.slug,
        ...argsOf(flags),
      });

      yield* print(result.text);
    });
