import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";

import {
  E2E_EMAIL,
  E2E_NAME,
  createAppWithKey,
  deleteApp,
  pushAppDir,
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
    git(["commit", "-m", `${slug} feature`]);
    git(["push", "-uf", "origin", "main:refs/heads/feature"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

test("a branch becomes an environment and Code mode frames it", async ({
  page,
  request,
}) => {
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

  // --- Code mode: the Preview panel frames what each branch deploys --------
  // Production's deploy ran while the environment was created; the default
  // branch frames it once it has a commit live.
  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status).toBe("success");
  await page.goto(`/apps/${appId}/source?ref=main&panel=preview`);
  const panel = page.getByRole("complementary", { name: "Preview" });
  const frame = panel.locator("iframe");
  // The default branch frames production (`<slug>.<base>`)…
  await expect(frame).toHaveAttribute("src", /^https?:\/\/envs\./u);
  // …and the address field navigates the frame, a path against its address.
  const address = panel.getByRole("textbox", { name: "Address" });
  await address.fill("/missing");
  await address.press("Enter");
  await expect(frame).toHaveAttribute(
    "src",
    /^https?:\/\/envs\.[^/]+\/missing$/u
  );
  // A branch with an environment frames that environment.
  await page.goto(`/apps/${appId}/source?ref=feature&panel=preview`);
  await expect(frame).toHaveAttribute("src", /^https?:\/\/feature\.envs\./u);
  await expect(
    panel.getByRole("link", { name: "Deploys for feature" })
  ).toHaveAttribute("href", /\/apps\/[0-9a-f-]+\?t=deployments&env=/u);
});
