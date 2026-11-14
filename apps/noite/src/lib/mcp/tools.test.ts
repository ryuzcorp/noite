import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import {
  installRunnerMock,
  makeApp,
  MockRefusal,
} from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { grantCollaborator } from "../collaborators";
import { ensureDb, setD1Binding } from "../db";
import type { KeyPrincipal } from "../key-principal";
import { deployWaitGate, MAX_CONCURRENT_WAITS } from "./deploy-wait";
import { McpToolError } from "./protocol";
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

/** The agent loop's write tools: the one argument each requires beyond `app`.
 * A wrong entry here means an agent sees a contract the server does not
 * enforce (or the reverse), so the published schema is the assertion. */
const LOOP_TOOLS = {
  cancel_deploy: ["app", "deployId"],
  close_pr: ["app", "number"],
  comment_pr: ["app", "body", "number"],
  commit_files: ["app", "message"],
  create_branch: ["app", "name"],
  create_pr: ["app", "head", "title"],
  delete_branch: ["app", "name"],
  get_pr: ["app", "number"],
  list_prs: ["app"],
  merge_pr: ["app", "number"],
  redeploy: ["app"],
  review_pr: ["app", "number", "state"],
  rollback: ["app", "sha"],
  wait_for_deploy: ["app"],
} satisfies Record<string, readonly string[]>;

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

  test("publishes every agent-loop tool with its required arguments", () => {
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

    for (const [name, required] of Object.entries(LOOP_TOOLS)) {
      const tool = byName.get(name);
      expect(tool, `${name} is missing from MCP_TOOLS`).toBeDefined();

      const published = Schema.decodeUnknownSync(PublishedSchema)(
        tool?.inputSchema
      );

      // The published `required` list is sorted by the schema library, so the
      // expectation is too: the same set, never a different contract.
      expect(
        published.required.toSorted(),
        `${name} requires ${required.join(", ")}`
      ).toEqual([...required].toSorted());
    }
  });

  test("names every tool exactly once", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---- The agent loop's write gates and refusals ----
//
// Real D1 grants and the runner double: the gate is the product's own
// (`requireApp` -> `keyAppVerdict` -> the owner's role, the key's app set and
// its ceiling), and the refusals are the codes an agent branches on.

const APP = makeApp({ id: "app-1", slug: "app-one", userId: "u-creator" });
const OTHER = makeApp({ id: "app-2", name: "Two", slug: "two", userId: "u-x" });

/** A principal for one account, account-wide unless a test narrows it. */
const principalFor = (
  userId: string,
  over: Partial<KeyPrincipal> = {}
): KeyPrincipal => ({
  expiresAt: null,
  keyId: `key-${userId}`,
  keyName: "ci",
  scope: { appIds: null, roleCeiling: "admin" },
  userId,
  ...over,
});

let db: TestD1;
let runner: RunnerMock;

/** One route's canned answer (a `MockRefusal` refuses like the runner). */
type RouteAnswer = (params: Record<string, Json>) => Json | MockRefusal;

/** Route answers the loop tools read, filled per test. The double reads the
 * map on every call, so a test's assignments always apply. The key is
 * `"<METHOD> <path>"`, the way the double records its calls. */
const answers = new Map<string, RouteAnswer>();

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
  runner = installRunnerMock([APP, OTHER], {
    resolve: ({ method, params, path }) =>
      answers.get(`${method} ${path}`)?.(params),
  });
});

beforeEach(async () => {
  answers.clear();

  db.raw.run(`DELETE FROM app_collaborator`);
  db.raw.run(`DELETE FROM "user"`);

  for (const [id, role] of [
    ["u-creator", "admin"],
    ["u-push", "push"],
    ["u-view", "view"],
    ["u-stranger", "user"],
  ] as const) {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, role) VALUES (?, ?, ?, ?)`,
      [id, id, `${id}@example.com`, role]
    );
  }

  await grantCollaborator("app-1", "u-push", "push");
  await grantCollaborator("app-1", "u-view", "view");
});

afterAll(() => {
  runner.restore();
});

/** One tool's single `invoke`, resolving to the error it threw. */
const invocationError = async (
  name: string,
  principal: KeyPrincipal,
  args: Schema.Json
): Promise<Error> => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);

  if (!tool) {
    throw new Error(`${name} is missing from MCP_TOOLS`);
  }

  try {
    await tool.invoke({ principal }, args);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error(`${name} answered without refusing`);
};

/** One tool's result, for the paths that must not refuse. */
const invocationResult = async (
  name: string,
  principal: KeyPrincipal,
  args: Schema.Json
) => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);

  if (!tool) {
    throw new Error(`${name} is missing from MCP_TOOLS`);
  }

  return await tool.invoke({ principal }, args);
};

/** One recorded call's params, parsed as the JSON object the transport
 * carried. */
const RequestParams = Schema.Record(Schema.String, Schema.Json);

const decodeParams = Schema.decodeUnknownSync(RequestParams);

/** The params of the last call to one route (the double records the two
 * lists in step). */
const requestFor = (route: string): Record<string, Json> => {
  const index = runner.calls.lastIndexOf(route);

  if (index === -1) {
    throw new Error(`${route} was never called`);
  }

  return decodeParams(runner.requests[index]);
};

const refusalCode = (thrown: Error): string | null =>
  thrown instanceof McpToolError ? (thrown.refusal?.code ?? null) : null;

/** The parts of a tool's `structuredContent` these tests read, parsed at the
 * boundary like the transport's own consumers do. */
const WaitAnswer = Schema.Struct({
  done: Schema.Boolean,
  resume: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ arguments: Schema.Json, tool: Schema.String })
    )
  ),
  status: Schema.NullOr(Schema.String),
});

const decodeWait = Schema.decodeUnknownSync(WaitAnswer);

const file = [{ content: "hi\n", path: "README.md" }];

describe("the agent loop's gates", () => {
  test("a key limited to another app is refused before the runner is touched", async () => {
    const thrown = await invocationError(
      "commit_files",
      principalFor("u-push", {
        scope: { appIds: ["app-2"], roleCeiling: "admin" },
      }),
      { app: "app-one", files: file, message: "m" }
    );

    expect(refusalCode(thrown)).toBe("forbidden");
    expect(thrown instanceof Error && thrown.message).toContain("app-one");
    expect(runner.calls).not.toContain("GET /v1/apps/app-1/git/refs");
  });

  test("a view-capped key cannot push even with the push role", async () => {
    const thrown = await invocationError(
      "create_branch",
      principalFor("u-push", { scope: { appIds: null, roleCeiling: "view" } }),
      { app: "app-one", name: "feature" }
    );

    expect(refusalCode(thrown)).toBe("forbidden");
    expect(runner.calls).not.toContain("POST /v1/apps/app-1/git/branches");
  });

  test("an account with no grant on the app is refused", async () => {
    const thrown = await invocationError(
      "list_prs",
      principalFor("u-stranger"),
      { app: "app-one" }
    );

    expect(refusalCode(thrown)).toBe("forbidden");
  });

  test("deleting a branch needs the admin role", async () => {
    const thrown = await invocationError(
      "delete_branch",
      principalFor("u-push"),
      { app: "app-one", name: "feature" }
    );

    expect(refusalCode(thrown)).toBe("forbidden");
  });
});

describe("commit_files", () => {
  const refs = {
    branches: [
      {
        ahead: 0,
        authorName: "Ada",
        behind: 0,
        committedAt: 0,
        name: "main",
        sha: "a".repeat(40),
        subject: "root",
      },
    ],
    defaultBranch: "main",
    deployedSha: null,
  };

  test("refuses a base on a branch that already exists", async () => {
    answers.set("GET /v1/apps/app-1/git/refs", () => refs);

    const thrown = await invocationError(
      "commit_files",
      principalFor("u-push"),
      {
        app: "app-one",
        base: "main",
        files: file,
        message: "m",
      }
    );

    expect(refusalCode(thrown)).toBe("invalid");
    expect(runner.calls).not.toContain("POST /v1/apps/app-1/source/commit");
  });

  test("refuses a stale expectedTip, naming both tips", async () => {
    answers.set("GET /v1/apps/app-1/git/refs", () => refs);

    const thrown = await invocationError(
      "commit_files",
      principalFor("u-push"),
      {
        app: "app-one",
        expectedTip: "deadbeef",
        files: file,
        message: "m",
      }
    );

    expect(refusalCode(thrown)).toBe("stale_tip");
    expect(thrown instanceof Error && thrown.message).toContain("deadbeef");
    expect(runner.calls).not.toContain("POST /v1/apps/app-1/source/commit");
  });

  test("a hidden preview base is refused before it can become a parent", async () => {
    // `refs/previews/…` is another user's uncommitted workspace snapshot. The
    // tool refuses a raw ref as invalid, and never forwards it as `fromSha`.
    answers.set("GET /v1/apps/app-1/git/refs", () => refs);

    const thrown = await invocationError(
      "commit_files",
      principalFor("u-push"),
      {
        app: "app-one",
        base: "refs/previews/u-1/main",
        branch: "leak",
        files: file,
        message: "m",
      }
    );

    expect(refusalCode(thrown)).toBe("invalid");
    expect(runner.calls).not.toContain("POST /v1/apps/app-1/source/commit");
  });

  test("a raw expectedTip is refused like a raw base", async () => {
    answers.set("GET /v1/apps/app-1/git/refs", () => refs);

    const thrown = await invocationError(
      "commit_files",
      principalFor("u-push"),
      {
        app: "app-one",
        branch: "main",
        expectedTip: "refs/previews/u-1/main",
        files: file,
        message: "m",
      }
    );

    expect(refusalCode(thrown)).toBe("invalid");
    expect(runner.calls).not.toContain("POST /v1/apps/app-1/source/commit");
  });

  test("needs at least one change", async () => {
    const thrown = await invocationError(
      "commit_files",
      principalFor("u-push"),
      {
        app: "app-one",
        message: "m",
      }
    );

    expect(thrown).toBeInstanceOf(McpToolError);

    if (!(thrown instanceof McpToolError)) {
      throw new TypeError("expected a tool error");
    }

    expect(thrown.invalid).toBe(true);
  });
});

/** One PR row as the runner answers it. */
const prDetailFixture = () => ({
  approvals: 0,
  comments: [],
  compare: {
    ahead: 1,
    base: "main",
    baseSha: "b".repeat(40),
    behind: 0,
    commits: [],
    conflicts: [],
    files: [],
    head: "feature",
    headSha: "a".repeat(40),
    mergeBase: "c".repeat(40),
    mergeable: true,
    patch: "",
    truncated: false,
  },
  mergeState: "mergeable",
  pullRequest: {
    authorId: "u-push",
    authorLabel: "u-push via key ci",
    base: "main",
    body: "",
    closedAt: null,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    head: "feature",
    headSha: "a".repeat(40),
    mergeSha: null,
    mergedAt: null,
    mergedBy: null,
    number: 1,
    state: "open",
    title: "t",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  requirePr: false,
  requiredApprovals: 0,
  reviews: [],
});

describe("attribution", () => {
  test("a merge made with a key signs the merge commit and the row", async () => {
    answers.set("GET /v1/apps/app-1/pull_requests/1", () => prDetailFixture());
    answers.set("GET /v1/apps/app-1/environments", () => []);
    answers.set("POST /v1/apps/app-1/pull_requests/1/merge", () => ({
      ...prDetailFixture(),
      mergeState: "merged",
      pullRequest: {
        ...prDetailFixture().pullRequest,
        mergeSha: "d".repeat(40),
        state: "merged",
      },
    }));

    await invocationResult("merge_pr", principalFor("u-push"), {
      app: "app-one",
      number: 1,
    });

    const merge = requestFor("POST /v1/apps/app-1/pull_requests/1/merge");

    // The actor *is* the attributed name (`keyActor`), so the squash commit's
    // author and committer carry "<user> via key <name>"; the PR row's own
    // `authorLabel` was stored when the request was opened.
    expect(merge.actor).toEqual({
      name: "u-push via key ci",
      userId: "u-push",
    });
    expect(merge.role).toBe("push");
  });

  test("an MCP pull request carries the key's label", async () => {
    answers.set("GET /v1/apps/app-1/git/refs", () => ({
      branches: [
        {
          ahead: 1,
          authorName: "u",
          behind: 0,
          committedAt: 0,
          name: "feature",
          sha: "a".repeat(40),
          subject: "s",
        },
      ],
      defaultBranch: "main",
      deployedSha: null,
    }));
    answers.set("POST /v1/apps/app-1/pull_requests", () => prDetailFixture());
    answers.set("GET /v1/apps/app-1/environments", () => []);

    await invocationResult("create_pr", principalFor("u-push"), {
      app: "app-one",
      head: "feature",
      title: "t",
    });

    const create = requestFor("POST /v1/apps/app-1/pull_requests");

    expect(create.authorLabel).toBe("u-push via key ci");
  });
});

describe("deploy tools", () => {
  test("redeploy refuses when nothing has deployed", async () => {
    const thrown = await invocationError("redeploy", principalFor("u-push"), {
      app: "app-one",
    });

    expect(refusalCode(thrown)).toBe("no_deploy");
  });

  test("wait_for_deploy answers a settled row without waiting", async () => {
    answers.set("GET /v1/apps/app-1/deploys", () => [
      {
        actor: null,
        appId: "app-1",
        createdAt: "2026-01-01T00:00:00Z",
        environmentId: null,
        id: "dep-1",
        intent: "deploy",
        log: "",
        sha: "a".repeat(40),
        status: "success",
        updatedAt: "2026-01-01T00:00:10Z",
      },
    ]);

    const result = await invocationResult(
      "wait_for_deploy",
      principalFor("u-view"),
      {
        app: "app-one",
      }
    );

    const structured = decodeWait(result.structured);

    expect(structured.done).toBe(true);
    expect(structured.status).toBe("success");
    expect(structured.resume).toBeNull();
  });

  test("a moving deploy answers a resume hint instead of blocking", async () => {
    answers.set("GET /v1/apps/app-1/deploys", () => [
      {
        actor: null,
        appId: "app-1",
        createdAt: "2026-01-01T00:00:00Z",
        environmentId: null,
        id: "dep-1",
        intent: "deploy",
        log: "",
        sha: "a".repeat(40),
        status: "building",
        updatedAt: "2026-01-01T00:00:10Z",
      },
    ]);

    const result = await invocationResult(
      "wait_for_deploy",
      principalFor("u-view"),
      {
        app: "app-one",
        maxWaitSeconds: 1,
      }
    );

    const structured = decodeWait(result.structured);

    expect(structured.done).toBe(false);
    expect(structured.status).toBe("building");
    expect(structured.resume?.tool).toBe("wait_for_deploy");
    expect(structured.resume?.arguments).toEqual({
      app: "app-one",
      deployId: null,
      environment: null,
      maxWaitSeconds: 1,
      sha: null,
    });
  });

  test("a key already holding every wait slot is refused, not queued", async () => {
    const principal = principalFor("u-view");

    const held = Array.from({ length: MAX_CONCURRENT_WAITS }, () => {
      deployWaitGate.enter(principal.keyId);

      return principal.keyId;
    });

    try {
      answers.set("GET /v1/apps/app-1/deploys", () => {
        throw new Error("a refused wait must not read the runner");
      });

      const before = runner.calls.length;

      const thrown = await invocationError("wait_for_deploy", principal, {
        app: "app-one",
      });

      expect(refusalCode(thrown)).toBe("too_many_waits");
      expect(runner.calls.slice(before)).not.toContain(
        "GET /v1/apps/app-1/deploys"
      );
      expect(deployWaitGate.active(principal.keyId)).toBe(held.length);
    } finally {
      for (const _ of held) {
        deployWaitGate.leave(principal.keyId);
      }
    }

    expect(deployWaitGate.active(principal.keyId)).toBe(0);
  });

  test("a completed wait releases its slot", async () => {
    const principal = principalFor("u-view");

    answers.set("GET /v1/apps/app-1/deploys", () => [
      {
        actor: null,
        appId: "app-1",
        createdAt: "2026-01-01T00:00:00Z",
        environmentId: null,
        id: "dep-1",
        intent: "deploy",
        log: "",
        sha: "a".repeat(40),
        status: "success",
        updatedAt: "2026-01-01T00:00:10Z",
      },
    ]);

    await invocationResult("wait_for_deploy", principal, { app: "app-one" });

    expect(deployWaitGate.active(principal.keyId)).toBe(0);
  });
});

describe("pull-request refusals", () => {
  test("merging a conflicting pull request is not_mergeable", async () => {
    answers.set("GET /v1/apps/app-1/pull_requests/1", () => prDetailFixture());
    answers.set(
      "POST /v1/apps/app-1/pull_requests/1/merge",
      () =>
        new MockRefusal(409, "merge conflicts: src/a.ts — resolve them locally")
    );

    const thrown = await invocationError("merge_pr", principalFor("u-push"), {
      app: "app-one",
      number: 1,
    });

    expect(refusalCode(thrown)).toBe("not_mergeable");
  });

  test("closing a pull request that already merged is not_open", async () => {
    answers.set(
      "PATCH /v1/apps/app-1/pull_requests/1",
      () => new MockRefusal(409, "this pull request is not open")
    );

    const thrown = await invocationError("close_pr", principalFor("u-push"), {
      app: "app-one",
      number: 1,
    });

    expect(refusalCode(thrown)).toBe("not_open");
  });
});
