import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { sleep } from "$lib/sleep";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  E2E_EMAIL,
  E2E_NAME,
  createAppWithKey,
  deleteApp,
  runnerApi,
  runnerCall,
  waitForDeploy,
} from "./helpers";

// Per-environment telemetry: an environment records its own metrics and
// errors (production never sees them), the telemetry tabs scope by `?env=`,
// and the head branch's pull request shows the environment card.
//
// Timing follows worker-errors.spec.ts: celld flushes OTel to the bucket
// every RUNNER_OTEL_FLUSH_MS (30 s), the runner ingests at most once per
// flush interval, and the ingest window stops agg_lag (flush + 10 s = 40 s)
// behind now — so a throw/request surfaces after ~100 s steady-state. 300 s
// is 3x headroom for a cold fleet and S3 listing.

const SLUG = "env-telemetry";
const BRANCH = "feature";
const LABEL = "feature";

const SAMPLE = new URL("../test/vite", import.meta.url);

const gitBase = process.env.E2E_GIT_BASE ?? "http://localhost:8080/v1/git";

/** The app this spec creates, dropped afterwards: the account's app quota
 * (10) is shared by the whole lane, and a leftover slug fails the next run's
 * create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

interface ErrorIssue {
  fingerprint: string;
  message: string;
}

interface ErrorList {
  counts: { ignored: number; open: number; resolved: number };
  issues: ErrorIssue[];
}

interface MetricRow {
  errors: number;
  requests: number;
}

interface RunnerEnvironment {
  id: string;
  label: string;
  status: string;
}

/** `runnerCall` widens its body to a union; each caller already knows the
 * shape its endpoint answers, so the cast is local to the read. */
const asJson = <T>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- runnerCall parses the body at the HTTP boundary; only its static type is unknown here.
  body: unknown
): T =>
  // SAFETY: the caller names the exact response type of the endpoint it hit (the REST mirror of the matching RPC).
  body as T;

/** Runner JSON-RPC through the raw-port lane, unwrapping `result`. */
const rpc = async <T>(
  request: APIRequestContext,
  method: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- params differ per method; the runner parses per-method and rejects mismatches.
  params: Record<string, unknown>
): Promise<T> => {
  const { body, status } = await runnerCall(request, "/rpc", {
    body: { id: 1, jsonrpc: "2.0", method, params },
    method: "POST",
  });

  expect(status).toBe(200);

  // SAFETY: the runner answers JSON-RPC `{ result }` on success; anything else fails the expects below.
  const payload = asJson<{
    error?: { code: number; message: string };
    result?: T;
  }>(body);

  expect(payload.error).toBeUndefined();

  // SAFETY: error is undefined above, so this is a success envelope carrying `result`.
  return payload.result as T;
};

/** Push the vite sample with a throwing `/api/env-boom` route carrying
 * `token` in the thrown message, so each branch's issue is unambiguous.
 * Same anchors as worker-errors.spec.ts (async fetch: celld's bucket OTel
 * sink only exports a span for an async handler's rejection). Without
 * `branch` the push lands on main, else on `refs/heads/<branch>`. */
const pushBoomRevision = (
  apiKey: string,
  slug: string,
  token: string,
  branch?: string
): string => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), `noite-${slug}-boom-`));

  try {
    cpSync(SAMPLE, dir, { recursive: true });
    const file = nodePath.join(dir, "src", "index.ts");
    const before = readFileSync(file, "utf-8");
    const signature = "fetch(request: Request): Response {";
    const anchor = 'return new Response("not found", { status: 404 });';

    if (!before.includes(signature) || !before.includes(anchor)) {
      throw new Error("the vite sample worker moved; update the boom hook");
    }

    const hook = `if (pathname === "/api/env-boom") {
      // E2E hook (env-telemetry.spec.ts): throws inside the Worker so the
      // Errors tab records an uncaught Worker issue carrying the token.
      throw new Error("env-boom-${token}");
    }

    `;

    writeFileSync(
      file,
      before
        .replace(
          signature,
          "async fetch(request: Request): Promise<Response> {"
        )
        .replace(anchor, hook + anchor)
    );
    rmSync(nodePath.join(dir, ".git"), { force: true, recursive: true });

    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: E2E_EMAIL,
          GIT_AUTHOR_NAME: E2E_NAME,
          GIT_COMMITTER_EMAIL: E2E_EMAIL,
          GIT_COMMITTER_NAME: E2E_NAME,
        },
      });

    git(["init", "-b", "main"]);
    git([
      "remote",
      "add",
      "origin",
      `http://git:${apiKey}@${gitBase.replace(/^https?:\/\//u, "")}/${slug}`,
    ]);
    git(["add", "-A"]);
    git(["commit", "-m", `${slug} ${branch ?? "main"} boom`]);

    if (branch === undefined) {
      git(["push", "-uf", "origin", "main"]);
    } else {
      git(["push", "-uf", "origin", `main:refs/heads/${branch}`]);
    }

    return git(["rev-parse", "HEAD"]).trim();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/** Poll one environment's deploy history until the tip is terminal. */
const waitForEnvDeploy = async (
  request: APIRequestContext,
  appId: string,
  environmentId: string,
  timeoutMs = 8 * 60_000
): Promise<void> => {
  const start = Date.now();

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential deploy poll with early exit
    const deploys = await runnerApi<{ status: string }[]>(
      request,
      `/v1/apps/${appId}/deploys?environmentId=${encodeURIComponent(environmentId)}`
    );

    const [latest] = deploys;

    if (latest?.status === "success") {
      return;
    }

    if (latest?.status === "failed") {
      throw new Error(`environment deploy failed: ${JSON.stringify(latest)}`);
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`environment deploy did not finish in ${timeoutMs}ms`);
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
    await sleep(1000);
  }
};

const metricTotal = async (
  request: APIRequestContext,
  appId: string,
  environmentId: string
): Promise<number> => {
  const query =
    environmentId === ""
      ? "hours=24"
      : `hours=24&environmentId=${encodeURIComponent(environmentId)}`;

  const rows = await runnerApi<MetricRow[]>(
    request,
    `/v1/apps/${appId}/metrics?${query}`
  );

  return rows.reduce((sum, row) => sum + row.requests, 0);
};

/** One open issue whose message contains `needle` under one scope
 * ("" = production), or null. */
const findIssue = async (
  request: APIRequestContext,
  appId: string,
  environmentId: string,
  needle: string
): Promise<ErrorIssue | null> => {
  const listed = await rpc<ErrorList>(request, "errors.list", {
    environmentId: environmentId === "" ? undefined : environmentId,
    id: appId,
    status: "open",
  });

  return listed.issues.find((issue) => issue.message.includes(needle)) ?? null;
};

test(
  "telemetry splits per environment and the PR shows its card",
  { tag: "@fast" },
  async ({ page, request }) => {
    createdApps.push(SLUG);

    const prodToken = `prod-${Date.now().toString(36)}`;
    const envToken = `env-${Math.random().toString(36).slice(2, 8)}`;

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "Env Telemetry",
      slug: SLUG,
    });

    pushBoomRevision(apiKey, SLUG, prodToken);
    pushBoomRevision(apiKey, SLUG, envToken, BRANCH);

    const deploy = await waitForDeploy(request, appId);

    expect(deploy.status, deploy.log).toBe("success");

    // --- the PR page offers to create the head branch's environment -------
    const prRes = await runnerCall(request, `/v1/apps/${appId}/pull_requests`, {
      body: {
        actor: { name: "e2e", userId: "e2e" },
        base: "main",
        head: BRANCH,
        title: "Feature work",
      },
      method: "POST",
    });

    expect(prRes.status).toBe(200);

    const prNumber = asJson<{ pullRequest: { number: number } }>(prRes.body)
      .pullRequest.number;

    await page.goto(`/apps/${appId}/pulls/${prNumber}`);
    await expect(
      page.getByText(`No environment for ${BRANCH} yet.`)
    ).toBeVisible();
    await page.getByRole("button", { name: "Create environment" }).click();

    const branchSelect = page.locator("#env-branch");

    await expect(branchSelect).toHaveValue(BRANCH);
    await page
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "Create environment" })
      .click();
    await expect(
      page.getByRole("link", { name: "Open environment" })
    ).toBeVisible({ timeout: 30_000 });

    const environments = await rpc<RunnerEnvironment[]>(
      request,
      "environments.list",
      { id: appId, role: "admin" }
    );

    const environment = environments.find((row) => row.label === LABEL);

    expect(environment).toBeDefined();

    const envId = environment?.id ?? "";

    await waitForEnvDeploy(request, appId, envId);

    // Through the lane Caddy, like worker-errors.spec.ts: the tenant site
    // sets a sampled traceparent so the ingest joins the exception to its
    // method, path and status.
    const prodBase = `http://${SLUG}.noite.localhost:8090`;
    const envBase = `http://${LABEL}.${SLUG}.noite.localhost:8090`;

    await expect
      .poll(
        async () => {
          const res = await request
            .get(`${prodBase}/api/greeting`)
            .catch(() => null);

          return res?.ok() ? await res.json() : null;
        },
        { intervals: [1000], timeout: 60_000 }
      )
      .toEqual({ greeting: "hello from vite" });

    // The environment is members-only by default: the browser handshake
    // (edge 302 → control grant → env cookie) admits this session, and the
    // context's later requests carry the cookie.
    await page.goto(`${envBase}/api/greeting`);
    await expect(page.locator("body")).toContainText("hello from vite");

    // Prod takes the readiness greeting + 3 greetings + 1 throw; the
    // environment takes the handshake greeting + 1 greeting + 1 throw
    // (a retry or a favicon fetch would only add real requests, so the
    // totals are lower bounds, captured for the tab assertions below).
    await request.get(`${prodBase}/api/greeting`);
    await request.get(`${prodBase}/api/greeting`);
    await request.get(`${prodBase}/api/greeting`);

    const prodBoom = await request.get(`${prodBase}/api/env-boom`);

    expect(prodBoom.status()).toBe(500);
    await page.request.get(`${envBase}/api/greeting`);

    const envBoom = await page.request.get(`${envBase}/api/env-boom`);

    expect(envBoom.status()).toBe(500);

    // --- metrics split per environment ------------------------------------
    let prodTotal = 0;
    await expect
      .poll(
        async () => {
          prodTotal = await metricTotal(request, appId, "");

          return prodTotal;
        },
        {
          intervals: [5000],
          timeout: 300_000,
        }
      )
      .toBeGreaterThanOrEqual(5);
    let envTotal = 0;
    await expect
      .poll(
        async () => {
          envTotal = await metricTotal(request, appId, envId);

          return envTotal;
        },
        {
          intervals: [5000],
          timeout: 300_000,
        }
      )
      .toBeGreaterThanOrEqual(3);

    // --- the throwing route issues under the environment, not prod --------
    await expect
      .poll(() => findIssue(request, appId, envId, envToken), {
        intervals: [5000],
        timeout: 300_000,
      })
      .not.toBeNull();
    await expect
      .poll(() => findIssue(request, appId, "", prodToken), {
        intervals: [5000],
        timeout: 300_000,
      })
      .not.toBeNull();
    expect(await findIssue(request, appId, "", envToken)).toBeNull();

    const envIssue = await findIssue(request, appId, envId, envToken);
    const prodIssue = await findIssue(request, appId, "", prodToken);

    expect(envIssue).not.toBeNull();
    expect(prodIssue).not.toBeNull();

    // --- tabs scope by `?env=` ----------------------------------------------
    await page.goto(`/apps/${appId}?t=metrics&env=${envId}`);
    await expect(
      page.getByRole("combobox", { name: "Environment" })
    ).toHaveValue(envId);
    await expect(page.getByText(`${envTotal} requests`).first()).toBeVisible({
      timeout: 60_000,
    });
    await page.goto(`/apps/${appId}?t=metrics`);
    await expect(page.getByText(`${prodTotal} requests`).first()).toBeVisible({
      timeout: 60_000,
    });

    await page.goto(`/apps/${appId}?t=errors&env=${envId}`);
    await expect(page.getByText(envToken).first()).toBeVisible({
      timeout: 60_000,
    });
    await page.goto(`/apps/${appId}?t=errors`);
    await expect(page.getByText(prodToken).first()).toBeVisible({
      timeout: 60_000,
    });

    // The environment's issue symbolicates against its own deploy's map.
    await page.goto(
      `/apps/${appId}?t=errors&env=${envId}&e=${envIssue?.fingerprint}`
    );
    await expect(page.getByText("src/index.ts").first()).toBeVisible({
      timeout: 60_000,
    });

    // --- the PR page shows the head branch's environment card ---------------
    await page.goto(`/apps/${appId}/pulls/${prNumber}`);

    const card = page.getByRole("link", { name: "Open environment" });

    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("target", "_blank");
    await expect(card).toHaveAttribute(
      "href",
      new RegExp(`^https?://${LABEL}\\.${SLUG}\\.`, "u")
    );
    await expect(page.getByText("running")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Deploy log" })
    ).toHaveAttribute("href", `/apps/${appId}?t=deployments&env=${envId}`);
    await expect(page.getByRole("link", { name: "Metrics" })).toHaveAttribute(
      "href",
      `/apps/${appId}?t=metrics&env=${envId}`
    );
    await expect(page.getByRole("link", { name: "Errors" })).toHaveAttribute(
      "href",
      `/apps/${appId}?t=errors&env=${envId}`
    );
  }
);
