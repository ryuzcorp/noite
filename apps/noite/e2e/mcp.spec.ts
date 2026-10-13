import { sleep } from "$lib/sleep";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import type { Json } from "effect/Schema";

import {
  DEPLOY_POLL_MS,
  deleteApp,
  mintApiKey,
  pushAppDir,
  readInviteCode,
  registerInviteeAccount,
  runnerCall,
} from "./helpers";

// MCP (A4): an agent's key drives the whole app lifecycle over POST /mcp —
// create, push, deploy, read the repo, set variables — while a wrong key and
// another account's app stay out. The lane's control UI is the raw-port vite
// server (no Caddy), so the endpoint is the same origin Playwright talks to;
// the key comes from the account page, where a raw key is shown once.

const MCP_SLUG = "mcp-e2e";
const FOREIGN_SLUG = "mcp-foreign";

/** Every app this spec creates, dropped afterwards: the account's app quota
 * (10) is shared by the whole lane, and a leftover slug fails the next run's
 * create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

interface ToolPayload {
  content?: { text?: string; type?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

interface McpBody {
  error?: { code: number; message: string };
  id?: number | null;
  result?: ToolPayload & {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    tools?: { name: string }[];
  };
}

interface CreatedApp {
  app: { id: string; slug: string; status: string };
  gitRemote: string;
  pushInstructions: string;
  url: string;
}

interface DeployStatus {
  deploy: { id: string; sha: string | null; status: string } | null;
  live: boolean;
  slug: string;
  status: string;
}

interface RepoLog {
  log: { commits: { sha: string; subject: string }[]; nextSkip: number | null };
}

interface RepoFile {
  blob: { path: string; text: string };
}

interface EnvList {
  env: { name: string; value: string }[];
}

/** One JSON-RPC message, with the raw status so the auth cases can assert it. */
const callMcp = async (
  request: APIRequestContext,
  key: string,
  message: { id: number; method: string; params?: Json }
): Promise<{ body: McpBody; status: number }> => {
  const res = await request.post("/mcp", {
    data: { jsonrpc: "2.0", ...message },
    headers: { authorization: `Bearer ${key}` },
  });
  // SAFETY: the endpoint answers application/json for every POST it accepts or rejects (never SSE).
  const body = (await res.json()) as McpBody;
  return { body, status: res.status() };
};

/** One tool call's structuredContent; a failed tool throws with its text so
 * the assertion failure names the tool. */
const callTool = async <T>(
  request: APIRequestContext,
  key: string,
  id: number,
  name: string,
  args?: Json
): Promise<T> => {
  const { body } = await callMcp(request, key, {
    id,
    method: "tools/call",
    params: { arguments: args ?? {}, name },
  });
  const { result } = body;
  if (!result || result.isError) {
    throw new Error(
      `MCP tool ${name} failed: ${result?.content?.[0]?.text ?? JSON.stringify(body.error)}`
    );
  }
  // SAFETY: each call site names the tool whose structuredContent it reads.
  return result.structuredContent as T;
};

test("an MCP client creates an app, pushes, follows the deploy, reads it back and sets variables", async ({
  page,
  request,
}) => {
  createdApps.push(MCP_SLUG);
  const key = await mintApiKey(page, "mcp-e2e");

  // The handshake an MCP client opens with, then the catalogue it reads.
  const initialize = await callMcp(request, key, {
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "e2e" }, protocolVersion: "2025-06-18" },
  });
  expect(initialize.status).toBe(200);
  expect(initialize.body.result?.protocolVersion).toBe("2025-06-18");
  expect(initialize.body.result?.serverInfo?.name).toBe("noite");

  const listed = await callMcp(request, key, { id: 2, method: "tools/list" });
  const toolNames = listed.body.result?.tools?.map((tool) => tool.name) ?? [];
  expect(toolNames).toContain("list_apps");
  expect(toolNames).toContain("create_app");
  expect(toolNames).toContain("repo_log");
  expect(toolNames).toContain("env_set");

  // Create a blank app: the agent learns its id, URL, remote and how to push.
  const created = await callTool<CreatedApp>(request, key, 3, "create_app", {
    slug: MCP_SLUG,
    source: { kind: "blank" },
  });
  expect(created.app.slug).toBe(MCP_SLUG);
  expect(created.gitRemote).toContain(MCP_SLUG);
  expect(created.pushInstructions).toContain("git push -u origin main");
  expect(created.url).toContain(MCP_SLUG);

  const apps = await callTool<{ apps: { slug: string }[] }>(
    request,
    key,
    4,
    "list_apps"
  );
  expect(apps.apps.map((app) => app.slug)).toContain(MCP_SLUG);
  const templates = await callTool<{ templates: { id: string }[] }>(
    request,
    key,
    5,
    "list_templates"
  );
  expect(templates.templates.map((template) => template.id)).toContain("oxide");

  // Push the sample app with the same key, then follow the deploy over MCP.
  const pushedSha = pushAppDir(
    key,
    new URL("../test", import.meta.url),
    MCP_SLUG
  );

  let status: DeployStatus | null = null;
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential deploy poll with an early exit
    status = await callTool<DeployStatus>(request, key, 6, "deploy_status", {
      app: MCP_SLUG,
    });
    if (status.live && status.deploy?.status === "success") {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `deploy did not go live in time: ${JSON.stringify(status)}`
      );
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- poll backoff
    await sleep(DEPLOY_POLL_MS);
  }
  expect(status.deploy?.sha).toBe(pushedSha);

  const buildLog = await callTool<{ log: string }>(
    request,
    key,
    7,
    "deploy_log",
    {
      app: MCP_SLUG,
    }
  );
  expect(buildLog.log.length).toBeGreaterThan(0);

  // The commit the push made is what the repo tools report.
  const log = await callTool<RepoLog>(request, key, 8, "repo_log", {
    app: MCP_SLUG,
  });
  expect(log.log.commits[0]?.sha).toBe(pushedSha);
  const branches = await callTool<{
    refs: { branches: { name: string }[]; defaultBranch: string };
  }>(request, key, 9, "repo_branches", { app: MCP_SLUG });
  expect(branches.refs.defaultBranch).toBe("main");
  const tree = await callTool<{ tree: { files: { path: string }[] } }>(
    request,
    key,
    10,
    "repo_tree",
    { app: MCP_SLUG }
  );
  expect(tree.tree.files.map((file) => file.path)).toContain("package.json");
  const file = await callTool<RepoFile>(request, key, 11, "repo_file", {
    app: MCP_SLUG,
    path: "package.json",
  });
  expect(file.blob.text).toContain("counter");
  const commit = await callTool<{ detail: { patch: string } }>(
    request,
    key,
    12,
    "repo_commit",
    { app: MCP_SLUG, sha: pushedSha }
  );
  expect(commit.detail.patch.length).toBeGreaterThan(0);

  const detail = await callTool<{ app: { role: string; status: string } }>(
    request,
    key,
    13,
    "get_app",
    { app: MCP_SLUG }
  );
  expect(detail.app.role).toBe("admin");
  expect(detail.app.status).toBe("running");

  const logs = await callTool<{ lines: string[] }>(
    request,
    key,
    14,
    "app_logs",
    {
      app: MCP_SLUG,
      limit: 20,
    }
  );
  expect(Array.isArray(logs.lines)).toBe(true);
  const errors = await callTool<{ counts: { open: number } }>(
    request,
    key,
    15,
    "app_errors",
    { app: MCP_SLUG }
  );
  expect(errors.counts.open).toBe(0);

  // Variables: a flag shows its value, anything else stays hidden.
  await callTool(request, key, 16, "env_set", {
    app: MCP_SLUG,
    key: "FLAG_MCP_E2E",
    value: "1",
  });
  await callTool(request, key, 17, "env_set", {
    app: MCP_SLUG,
    key: "MCP_SECRET",
    value: "shh",
  });
  const env = await callTool<EnvList>(request, key, 18, "env_list", {
    app: MCP_SLUG,
  });
  expect(env.env.find((row) => row.name === "FLAG_MCP_E2E")?.value).toBe("1");
  // Everything that is not a 0/1 flag stays hidden, like the UI shows it.
  expect(env.env.find((row) => row.name === "MCP_SECRET")?.value).toBe("");
  await callTool(request, key, 19, "env_unset", {
    app: MCP_SLUG,
    key: "FLAG_MCP_E2E",
  });
  const after = await callTool<EnvList>(request, key, 20, "env_list", {
    app: MCP_SLUG,
  });
  expect(after.env.map((row) => row.name)).not.toContain("FLAG_MCP_E2E");

  // The transport itself: GET (the SSE probe) is refused, not SPA-fallback.
  const probe = await request.get("/mcp");
  expect(probe.status()).toBe(405);
});

test("a wrong key is refused and another account's app is denied", async ({
  browser,
  page,
  request,
}) => {
  // The lane's account bootstrapped the instance, so it is the instance admin:
  // an agent key on it resolves a role on every app, exactly as the UI does
  // (docs/reference/mcp). The denial has to come from a plain account's key —
  // register one with an invite code the admin's Account page hands out.
  const inviteCode = await readInviteCode(page);
  const invitee = await registerInviteeAccount(
    browser,
    inviteCode,
    `mcp-denied-${Date.now()}@example.com`,
    "MCP Denied"
  );
  const key = await mintApiKey(invitee.page, "mcp-e2e-denied");
  await invitee.context.close();

  const noKey = await request.post("/mcp", {
    data: { id: 1, jsonrpc: "2.0", method: "ping" },
  });
  expect(noKey.status()).toBe(401);
  expect(noKey.headers()["www-authenticate"]).toBe("Bearer");

  const wrongKey = await request.post("/mcp", {
    data: { id: 1, jsonrpc: "2.0", method: "ping" },
    headers: { authorization: "Bearer noite_not-a-real-key" },
  });
  expect(wrongKey.status()).toBe(401);

  // An app no account has a grant on: created straight through the runner as
  // somebody else, so no collaborator row exists for our key's account.
  createdApps.push(FOREIGN_SLUG);
  const foreign = await runnerCall(request, "/v1/apps", {
    body: { name: "Foreign App", slug: FOREIGN_SLUG, user_id: "someone-else" },
    method: "POST",
  });
  expect(foreign.status).toBe(201);

  const denied = await callMcp(request, key, {
    id: 2,
    method: "tools/call",
    params: { arguments: { app: FOREIGN_SLUG }, name: "repo_log" },
  });
  expect(denied.body.result?.isError).toBe(true);
  expect(denied.body.result?.content?.[0]?.text).toContain(FOREIGN_SLUG);
});
