import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import type { Json } from "effect/Schema";

import {
  CHILD_PROC_TIMEOUT_MS,
  DEPLOY_POLL_MS,
  TERMINAL_DEPLOY_PATTERN,
  deleteApp,
  mintApiKey,
} from "./helpers";

// The agent loop end to end, with an API key and nothing else: no browser
// action, no git CLI. create_app -> commit_files -> create_branch/commit ->
// create_environment -> create_pr -> merge_pr -> wait_for_deploy -> rollback,
// all over `POST /mcp`; then the same loop's command-line feet (`noite pr
// list`, `noite deploy wait`) against the same app.

const SLUG = "agent-loop";
const FEATURE = "agent-loop-feature";
const MCP_SLUGS = [SLUG];

const control = new URL(
  process.env.E2E_BASE_URL ?? "http://noite.localhost:8090"
);

const cliDir = fileURLToPath(new URL("../../../packages/cli", import.meta.url));
const cliBin = nodePath.join(cliDir, "dist", "bin.js");

const sampleDir = fileURLToPath(new URL("../test", import.meta.url));

/** The sample app's root sources: what a Void app deploys from, small enough
 * to carry in one `commit_files` call. */
const SAMPLE_FILES = [
  "cloudflare.config.ts",
  "index.ts",
  "package.json",
  "tsconfig.json",
];

interface ToolPayload {
  content?: { text?: string; type?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

interface McpBody {
  error?: { code: number; message: string };
  result?: ToolPayload;
}

/** One tool call's structuredContent; a failed tool throws with its text, so
 * an assertion failure names the tool and the refusal. */
const callTool = async <T>(
  request: APIRequestContext,
  key: string,
  name: string,
  args: Json
): Promise<T> => {
  const res = await request.post("/mcp", {
    data: {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    },
    headers: { authorization: `Bearer ${key}` },
  });

  // SAFETY: the endpoint answers application/json for every POST it accepts
  // or rejects (never SSE), so the parsed body is this shape by contract.
  const body = (await res.json()) as McpBody;
  const { result } = body;

  if (!result || result.isError) {
    throw new Error(
      `MCP tool ${name} failed: ${result?.content?.[0]?.text ?? JSON.stringify(body.error)}`
    );
  }

  // SAFETY: each call site names the tool whose structuredContent it reads.
  return result.structuredContent as T;
};

interface DeployWait {
  deploy: { id: string; sha: string | null; status: string } | null;
  done: boolean;
  resume: unknown;
  status: string | null;
}

/** Poll `wait_for_deploy` until it reports a terminal row. The tool's own call
 * is bounded, so the loop re-arms it with the same arguments — exactly what an
 * agent does — and only the deadline can fail the wait. */
const waitForTerminal = async (
  request: APIRequestContext,
  key: string,
  args: Record<string, string>
): Promise<DeployWait> => {
  let last: DeployWait | undefined;

  await expect
    .poll(
      async () => {
        last = await callTool<DeployWait>(request, key, "wait_for_deploy", {
          maxWaitSeconds: 5,
          ...args,
        });

        return last.status ?? "none";
      },
      { intervals: [DEPLOY_POLL_MS], timeout: 8 * 60_000 }
    )
    .toMatch(TERMINAL_DEPLOY_PATTERN);

  if (
    last === undefined ||
    (last.status !== "success" &&
      last.status !== "failed" &&
      last.status !== "cancelled" &&
      last.status !== "stalled")
  ) {
    throw new Error(`no terminal deploy: ${JSON.stringify(last)}`);
  }

  return last;
};

/** Run the built CLI under plain node, resolving its combined output. */
const runCli = (args: readonly string[]): string => {
  const proc = spawnSync("node", [cliBin, ...args], {
    encoding: "utf-8",
    env: { ...process.env },
    killSignal: "SIGKILL",
    timeout: CHILD_PROC_TIMEOUT_MS,
  });

  if (proc.error) {
    throw proc.error;
  }

  const output = `${proc.stdout}${proc.stderr}`;

  if (proc.status !== 0) {
    throw new Error(`noite ${args.join(" ")} failed:\n${output}`);
  }

  return output;
};

test.afterAll(async ({ request }) => {
  for (const slug of MCP_SLUGS.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

test.beforeAll(() => {
  const proc = spawnSync("bun", ["run", "build"], {
    cwd: cliDir,
    encoding: "utf-8",
    killSignal: "SIGKILL",
    timeout: CHILD_PROC_TIMEOUT_MS,
  });

  if (proc.error) {
    throw proc.error;
  }

  expect(proc.status).toBe(0);
});

test("an agent takes an app from code to production and back with one key", async ({
  page,
  request,
}) => {
  const key = await mintApiKey(page, "agent-loop");

  const created = await callTool<{ app: { id: string; slug: string } }>(
    request,
    key,
    "create_app",
    { slug: SLUG, source: { kind: "blank" } }
  );

  expect(created.app.slug).toBe(SLUG);

  // 1. The first commit: the sample's own sources, straight from the agent.
  const files = SAMPLE_FILES.map((name) => ({
    content: readFileSync(nodePath.join(sampleDir, name), "utf-8"),
    path: name,
  }));

  const first = await callTool<{ deploy: { id: string } | null; sha: string }>(
    request,
    key,
    "commit_files",
    { app: SLUG, files, message: "agent loop: first commit" }
  );

  expect(first.sha).toHaveLength(40);

  const firstDeploy = await waitForTerminal(request, key, {
    app: SLUG,
    sha: first.sha,
  });

  expect(firstDeploy.status).toBe("success");

  // 2. A feature branch from main, with the compare-and-set: the tip the agent
  //    read is the one it commits onto.
  const branch = await callTool<{ branch: { sha: string } }>(
    request,
    key,
    "create_branch",
    { app: SLUG, from: "main", name: FEATURE }
  );

  expect(branch.branch.sha).toBe(first.sha);

  const feature = await callTool<{ sha: string }>(
    request,
    key,
    "commit_files",
    {
      app: SLUG,
      branch: FEATURE,
      expectedTip: first.sha,
      files: [{ content: "// agent loop\n", path: "AGENT.md" }],
      message: "agent loop: feature work",
    }
  );

  expect(feature.sha).not.toBe(first.sha);

  // 3. A preview environment for the branch, and its own deploy.
  const environment = await callTool<{
    environment: { label: string; url: string };
  }>(request, key, "create_environment", { app: SLUG, branch: FEATURE });

  const preview = await waitForTerminal(request, key, {
    app: SLUG,
    environment: environment.environment.label,
    sha: feature.sha,
  });

  expect(preview.status).toBe("success");
  expect(environment.environment.url).toContain(environment.environment.label);

  // 4. The pull request: checks read before merging, then the merge.
  const pr = await callTool<{
    pullRequest: { number: number };
  }>(request, key, "create_pr", {
    app: SLUG,
    head: FEATURE,
    title: "Agent loop: feature work",
  });

  const detail = await callTool<{
    checks: { name: string; state: string }[];
    environment: { label: string } | null;
    mergeState: string;
    pullRequest: { headSha: string; number: number };
  }>(request, key, "get_pr", { app: SLUG, number: pr.pullRequest.number });

  expect(detail.pullRequest.headSha).toBe(feature.sha);
  expect(detail.mergeState).toBe("mergeable");
  expect(detail.environment?.label).toBe(environment.environment.label);
  expect(detail.checks.map((check) => check.name).toSorted()).toEqual([
    "approvals",
    "mergeability",
    "preview",
  ]);
  // The preview deploy of the head commit is the check that passed.
  expect(detail.checks.find((check) => check.name === "preview")?.state).toBe(
    "ok"
  );

  const merged = await callTool<{
    mergeSha: string | null;
    pullRequest: { state: string };
  }>(request, key, "merge_pr", {
    app: SLUG,
    deleteBranch: true,
    number: pr.pullRequest.number,
  });

  expect(merged.pullRequest.state).toBe("merged");
  expect(merged.mergeSha).toHaveLength(40);

  // 5. The merge deploys production, and the row is the merge commit.
  const deploy = await waitForTerminal(request, key, {
    app: SLUG,
    sha: merged.mergeSha ?? "",
  });

  expect(deploy.status).toBe("success");
  expect(deploy.deploy?.sha).toBe(merged.mergeSha);

  // 6. Roll back to the first sha: the pipeline re-runs the old tip.
  const rollback = await callTool<{ deployId: string; sha: string }>(
    request,
    key,
    "rollback",
    { app: SLUG, sha: first.sha }
  );

  expect(rollback.sha).toBe(first.sha);

  const rolledBack = await waitForTerminal(request, key, {
    app: SLUG,
    deployId: rollback.deployId,
  });

  expect(rolledBack.status).toBe("success");

  // 7. The command line's feet, on the same key and app: the pull request the
  //    agent merged, and a deploy that has already settled (so `wait` answers
  //    its terminal status without waiting).
  const conn = ["--slug", SLUG, "--token", key, "--app-url", control.origin];

  const listed = runCli(["pr", "list", ...conn, "--state", "merged"]);

  expect(listed).toContain(`#${pr.pullRequest.number}`);
  expect(listed).toContain("merged");

  const waited = runCli([
    "deploy",
    ...conn,
    "wait",
    "--sha",
    first.sha,
    "--max-wait",
    "5",
    "--timeout",
    "30",
  ]);

  expect(waited).toContain("deploy success");

  // 8. The deploy log and the app's URL are readable with the same key.
  const status = await callTool<{ live: boolean; status: string }>(
    request,
    key,
    "deploy_status",
    { app: SLUG }
  );

  expect(status.status).toBe("running");
  expect(status.live).toBe(true);

  const log = await callTool<{ log: string }>(request, key, "deploy_log", {
    app: SLUG,
  });

  expect(log.log.length).toBeGreaterThan(0);
});
