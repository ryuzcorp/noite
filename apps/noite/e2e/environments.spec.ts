import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";

import {
  E2E_EMAIL,
  E2E_NAME,
  createAppWithKey,
  deleteApp,
  execGit,
  pushAppDir,
  runnerCall,
  waitForDeploy,
} from "./helpers";

// Preview environments: creating one from a branch lists its URL as its group
// on the app's Deployments tab, and Code mode's Preview panel frames each
// branch's own deployment.

const SLUG = "envs";

/** The sample app: both branches must really deploy, since the panel frames
 * production only once it has deployed, and a failed environment shows its
 * status instead of a frame. */
const SAMPLE = new URL("../test", import.meta.url);

const gitBase = process.env.E2E_GIT_BASE ?? "http://localhost:8080/v1/git";

/** Every app this spec creates, dropped after the file. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

/** Push `source` as a second branch of `slug` (main is pushed by `pushAppDir`),
 * so the app has a real ref that is not the default branch. */
const pushBranch = (apiKey: string, source: URL, slug: string): void => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), `noite-${slug}-branch-`));

  try {
    cpSync(source, dir, { recursive: true });
    rmSync(nodePath.join(dir, ".git"), { force: true, recursive: true });

    const git = (args: string[]): string =>
      execGit(args, {
        cwd: dir,
        env: {
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
    git(["commit", "-m", `${slug} feature`]);
    git(["push", "-uf", "origin", "main:refs/heads/feature"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

test(
  "a branch becomes an environment and serves its own host",
  { tag: "@fast" },
  async ({ page, request }) => {
    createdApps.push(SLUG);

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "Environments",
      slug: SLUG,
    });

    pushAppDir(apiKey, SAMPLE, SLUG);
    pushBranch(apiKey, SAMPLE, SLUG);

    // --- create an environment from the branch ------------------------------
    await page.goto(`/apps/${appId}?t=deployments`);
    await page.getByRole("button", { name: "Create environment" }).click();
    await page.locator("#env-branch").selectOption("feature");
    await page
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "Create environment" })
      .click();
    // The group lists the environment's own URL (`<label>.<slug>.<base>`).
    await expect(
      page.getByRole("link", { name: /feature\.envs\./u })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("feature", { exact: true }).first()
    ).toBeVisible();

    // The environment serves the branch's deploy on its own host. (Code mode no
    // longer frames it: the Preview panel went with the light editor, and an
    // environment is reached by its own URL.)
    const deploy = await waitForDeploy(request, appId);
    expect(deploy.status).toBe("success");

    // --- the environment rolls back to its own earlier release ---------------
    // The environment's history is its own; a sha that succeeded there is a
    // valid target, and the rebuild stays in that environment (production's
    // history never gains this row).
    const envs = await runnerCall(
      request,
      `/v1/apps/${appId}/environments?role=admin`
    );

    expect(envs.status, JSON.stringify(envs.body)).toBe(200);

    // SAFETY: the environments endpoint answers a JSON array of rows.
    const env = (envs.body as { id: string; label: string }[]).find(
      (e) => e.label === "feature"
    );

    expect(env).toBeDefined();

    let firstSuccess: { id: string; sha: string | null } | undefined;

    await expect
      .poll(
        async () => {
          const rows = await runnerCall(
            request,
            `/v1/apps/${appId}/deploys?environmentId=${env?.id ?? ""}`
          );

          // SAFETY: the deploys endpoint answers a JSON array of rows.
          firstSuccess = (
            rows.body as { id: string; sha: string | null }[]
          ).find(
            (r) => (r as { status?: string }).status === "success" && !!r.sha
          );

          return firstSuccess?.sha ?? "";
        },
        { timeout: 3 * 60_000 }
      )
      .not.toBe("");

    const rolled = await runnerCall(request, `/v1/apps/${appId}/rollback`, {
      body: {
        environmentId: env?.id ?? "",
        role: "admin",
        sha: firstSuccess?.sha ?? "",
      },
      method: "POST",
    });

    expect(rolled.status).toBe(200);

    // SAFETY: the rollback endpoint answers `{ deployId }` (its own contract).
    const rollbackId = (rolled.body as { deployId?: string }).deployId ?? "";

    await expect
      .poll(
        async () => {
          const rows = await runnerCall(
            request,
            `/v1/apps/${appId}/deploys?environmentId=${env?.id ?? ""}`
          );

          // SAFETY: the deploys endpoint answers a JSON array of rows.
          const row = (
            rows.body as {
              environmentId: string | null;
              id: string;
              status: string;
            }[]
          ).find((r) => r.id === rollbackId);

          return row?.status ?? "";
        },
        { timeout: 8 * 60_000 }
      )
      .toBe("success");

    // Production never saw this row: the rollback rebuilt the preview only.
    const prodRows = await runnerCall(request, `/v1/apps/${appId}/deploys`);

    // SAFETY: the deploys endpoint answers a JSON array of rows.
    const inProd = (prodRows.body as { id: string }[]).some(
      (r) => r.id === rollbackId
    );

    expect(inProd).toBe(false);
  }
);
