import { describe, expect, test } from "bun:test";

import * as Schema from "effect/Schema";

import { MCP_TOOLS, deployStatusLive } from "./tools";

/** The environment tools an agent (and the CLI, which calls them) depends on,
 * with the one argument each must require beyond `app`. */
const ENVIRONMENT_TOOLS = {
  create_environment: ["app", "branch"],
  delete_environment: ["app", "environment"],
  deploy_environment: ["app", "environment"],
  environment_env_list: ["app", "environment"],
  environment_env_set: ["app", "environment", "key", "value"],
  environment_env_unset: ["app", "environment", "key"],
  list_environments: ["app"],
  set_environment_public: ["app", "environment", "public"],
} satisfies Record<string, readonly string[]>;

/** The part of a published `inputSchema` these tests read. */
const PublishedSchema = Schema.Struct({
  required: Schema.Array(Schema.String),
});

describe("deploy_status's live flag", () => {
  test("a sleeping app is live: it serves again on the next request", () => {
    expect(
      deployStatusLive({ desiredState: "running", status: "sleeping" })
    ).toBe(true);
  });

  test("a running app is live", () => {
    expect(
      deployStatusLive({ desiredState: "running", status: "running" })
    ).toBe(true);
  });

  test("a crash-held fleet is not live even though its row says running", () => {
    expect(
      deployStatusLive({
        desiredState: "running",
        fleetHold: { hold: "crash", retryAt: "2026-11-10T16:40:05.000Z" },
        status: "running",
      })
    ).toBe(false);
  });

  test("a stopped app is not live", () => {
    expect(
      deployStatusLive({ desiredState: "stopped", status: "stopped" })
    ).toBe(false);
  });
});

describe("MCP tool table", () => {
  test("publishes every environment tool with its required arguments", () => {
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

    for (const [name, required] of Object.entries(ENVIRONMENT_TOOLS)) {
      const tool = byName.get(name);
      expect(tool, `${name} is missing from MCP_TOOLS`).toBeDefined();

      const published = Schema.decodeUnknownSync(PublishedSchema)(
        tool?.inputSchema
      );

      expect(
        published.required,
        `${name} requires ${required.join(", ")}`
      ).toEqual(required);
    }
  });

  test("names every tool exactly once", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
