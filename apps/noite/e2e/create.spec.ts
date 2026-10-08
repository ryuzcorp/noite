import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  findAppId,
  runnerApi,
  runnerCall,
  waitForDeploy,
} from "./helpers";

// A2/A3/A5: the new app creator (blank / GitHub import / template) and the
// push-to-create path. The import needs egress to github.com from the runner.
const UPSTREAM = "https://github.com/octocat/Hello-World";
const gitBase = process.env.E2E_GIT_BASE ?? "http://localhost:8080/v1/git";

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

interface RunnerAppRow {
  id: string;
  imported: boolean;
  status: string;
}

/** The app's history over the runner's REST mirror of `git.log` (what the
 * Source page reads). */
const gitLog = (request: APIRequestContext, appId: string) =>
  runnerApi<{ commits: { sha: string }[] }>(
    request,
    `/v1/apps/${appId}/git/log?limit=100`
  );

/** Fresh one-commit repo pushed at `slug`, with git's stderr captured (that is
 * where the first-push `remote:` line lands). */
const pushNewRepo = (apiKey: string, slug: string) => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), `noite-${slug}-`));
  try {
    cpSync(new URL("../test", import.meta.url), dir, { recursive: true });
    rmSync(nodePath.join(dir, ".git"), { force: true, recursive: true });
    const git = (args: string[], env: Record<string, string> = {}) => {
      const run = spawnSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, ...env },
      });
      if (run.status !== 0) {
        throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
      }
      return { stderr: run.stderr, stdout: run.stdout };
    };
    git(["init", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-m", `${slug} deploy`], {
      GIT_AUTHOR_EMAIL: "e2e@noite.local",
      GIT_AUTHOR_NAME: "E2E",
      GIT_COMMITTER_EMAIL: "e2e@noite.local",
      GIT_COMMITTER_NAME: "E2E",
    });
    git([
      "remote",
      "add",
      "origin",
      `http://git:${apiKey}@${gitBase.replace(/^https?:\/\//u, "")}/${slug}`,
    ]);
    const push = git(["push", "-u", "origin", "main"], {
      GIT_TERMINAL_PROMPT: "0",
    });
    return {
      sha: git(["rev-parse", "HEAD"]).stdout.trim(),
      stderr: push.stderr,
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

test("imports a public GitHub repo with its history", async ({
  page,
  request,
}) => {
  createdApps.push("hello-world");
  await page.goto("/apps/new");
  await page.getByRole("tab", { name: "Import from GitHub" }).click();
  await page.locator("#create-url").fill(UPSTREAM);
  // The slug prefills from the repo; the name stays the user's to write.
  await expect(page.locator("#create-slug")).toHaveValue("hello-world");
  await page.locator("#create-name").fill("Hello World");
  await page.getByRole("button", { name: "Create app" }).click();
  await page.waitForURL("**/apps", { timeout: 30_000 });

  const appId = await findAppId(request, "hello-world");
  expect(appId).not.toBeNull();
  const id = appId ?? "";
  // The app exists before the clone finishes: A2 is asynchronous.
  const created = await runnerApi<RunnerAppRow>(request, `/v1/apps/${id}`);
  expect(created.imported).toBe(true);

  const deploy = await waitForDeploy(request, id);
  const [upstreamHead] = execFileSync("git", ["ls-remote", UPSTREAM, "HEAD"], {
    encoding: "utf-8",
  })
    .trim()
    .split(/\s+/u);
  // One-time copy: Noite's main is the upstream tip, history included.
  expect(deploy.sha).toBe(upstreamHead);
  const log = await gitLog(request, id);
  expect(log.commits.length).toBeGreaterThan(1);
  expect(log.commits[0]?.sha).toBe(upstreamHead);
});

test("rejects an import URL that is not a public GitHub repo", async ({
  page,
  request,
}) => {
  // The form refuses it before submitting…
  await page.goto("/apps/new");
  await page.getByRole("tab", { name: "Import from GitHub" }).click();
  await page
    .locator("#create-url")
    .fill("https://gitlab.com/octocat/Hello-World");
  await page.locator("#create-name").fill("Nope");
  await page.locator("#create-slug").fill("nope-import");
  await page.getByRole("button", { name: "Create app" }).click();
  await expect(page.getByRole("alert")).toContainText("GitHub");

  // …and the runner refuses it too: the URL allowlist is the security boundary,
  // because the clone is not covered by the tenant egress policy.
  const rejected = await runnerCall(request, "/v1/apps", {
    body: {
      name: "Nope",
      slug: "nope-import",
      source: {
        actor: { name: "E2E", userId: "local" },
        kind: "git",
        url: "https://gitlab.com/octocat/Hello-World",
      },
    },
    method: "POST",
  });
  expect(rejected.status).toBe(400);
  expect(String(rejected.body)).toContain("github.com");
  expect(await findAppId(request, "nope-import")).toBeNull();
});

test("pushing to a new slug creates the app and serves the push", async ({
  page,
  request,
}) => {
  createdApps.push("key-holder", "pushed-app");
  // Any account's API key may create an app this way; mint one on a throwaway
  // app through the same UI a user would.
  const { apiKey } = await createAppWithKey(page, request, {
    name: "Key Holder",
    slug: "key-holder",
  });
  const pushed = pushNewRepo(apiKey, "pushed-app");
  const appId = await findAppId(request, "pushed-app");
  expect(appId).not.toBeNull();
  const id = appId ?? "";
  // The pusher became its admin: the push went through and the deploy runs.
  const deploy = await waitForDeploy(request, id);
  expect(deploy.sha).toBe(pushed.sha);
  const app = await runnerApi<RunnerAppRow>(request, `/v1/apps/${id}`);
  expect(app.status).toBe("running");
  // The first push prints the app URL (a `remote:` sideband line).
  expect(pushed.stderr).toContain("pushed-app");
});

test("a reserved slug cannot be pushed into existence", async ({
  page,
  request,
}) => {
  createdApps.push("reserved-probe");
  const { apiKey } = await createAppWithKey(page, request, {
    name: "Reserved Probe",
    slug: "reserved-probe",
  });
  // The receive-pack advertisement for a reserved slug is a 404 whose body is
  // the same "repository not found" any unknown repo gets — the runner asks the
  // UI, which refuses the slug.
  const res = await request.get(
    `${gitBase}/api/info/refs?service=git-receive-pack`,
    { headers: { authorization: `Basic ${btoa(`git:${apiKey}`)}` } }
  );
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain("repository not found");
  expect(await findAppId(request, "api")).toBeNull();
});

test("the template picker lists the shipped templates", async ({ page }) => {
  await page.goto("/apps/new");
  await page.getByRole("tab", { name: "Template" }).click();
  await expect(
    page.getByRole("button", { name: /Oxide \+ ilha/u })
  ).toBeVisible();
  // Picking one prefills Name and Slug from the template (the slug from its id).
  await page.getByRole("button", { name: /TanStack Start/u }).click();
  await expect(page.locator("#create-name")).toHaveValue("TanStack Start");
  await expect(page.locator("#create-slug")).toHaveValue("tanstack-start");
});
