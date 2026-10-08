import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";

import { E2E_EMAIL, E2E_NAME, createAppWithKey, deleteApp } from "./helpers";

const FORGE_SLUG = "forge";

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

/** Push the sample checkout as `main`, then one extra commit on a `feature`
 * branch. Local to this spec — the shared helper pushes a single branch. */
const pushMainAndFeature = (apiKey: string, source: URL, slug: string) => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "noite-forge-"));
  try {
    cpSync(source, dir, { recursive: true });
    rmSync(nodePath.join(dir, ".git"), { force: true, recursive: true });
    const git = (args: string[]): string =>
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
    git(["commit", "-m", "forge: main commit"]);
    const main = git(["rev-parse", "HEAD"]).trim();
    git(["push", "-u", "origin", "main"]);
    git(["checkout", "-b", "feature"]);
    writeFileSync(
      nodePath.join(dir, "FEATURE.md"),
      "# Feature branch\n\nAdded on the feature branch.\n"
    );
    git(["add", "-A"]);
    git(["commit", "-m", "forge: feature commit"]);
    const feature = git(["rev-parse", "HEAD"]).trim();
    git(["push", "-u", "origin", "feature"]);
    return { feature, main };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

test("browse a branch, its history, a commit and a compare; create and delete a branch", async ({
  page,
  request,
}) => {
  createdApps.push(FORGE_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Forge App",
    slug: FORGE_SLUG,
  });
  const { feature } = pushMainAndFeature(
    apiKey,
    new URL("../test", import.meta.url),
    FORGE_SLUG
  );

  // The default (no `?ref=`) view browses the default branch, not the
  // deployed commit. It once sent an empty ref the runner refused, failing
  // with "Internal error".
  await page.goto(`/apps/${appId}/source`);
  await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Internal error")).toHaveCount(0);
  await expect(page.getByLabel("Branch or ref")).toHaveText("main");

  // The branch picker lists the pushed branch.
  await page.getByLabel("Branch or ref").click();
  // A branch's accessible name also carries its distance ("feature 1 ahead").
  await page.getByRole("button", { name: /^feature\b/u }).click();
  await expect(page).toHaveURL(/ref=feature/u);
  // Files come from the feature ref (its extra file shows in the tree).
  // The tree renders a name as a search-highlighted <div>/truncation pair, so
  // its text is split — match the item by the accessible name it exposes.
  await expect(page.getByRole("treeitem", { name: "FEATURE.md" })).toBeVisible({
    timeout: 30_000,
  });

  // The History panel lists the ref's commits (feature on top of main).
  await page.getByRole("button", { exact: true, name: "History" }).click();
  await expect(page).toHaveURL(/panel=history/u);
  await expect(
    page.getByRole("link", { name: "forge: feature commit" })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("link", { name: "forge: main commit" })
  ).toBeVisible();

  // The commit page shows the metadata and the rendered diff.
  await page.getByRole("link", { name: "forge: feature commit" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${appId}/source/commit/${feature}`, "u")
  );
  await expect(page.getByRole("heading", { name: "Diff" })).toBeVisible();
  await expect(page.getByText("FEATURE.md").first()).toBeVisible({
    timeout: 30_000,
  });

  // Compare feature against main: one commit ahead, no conflicts.
  await page.goto(`/apps/${appId}/source/compare?base=main&head=feature`);
  await expect(page.getByText(/1 commit ahead/u)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("ready to squash-merge")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Commits" })).toBeVisible();

  // Compare opens the new-pull page; the sidebar's Pulls item opens the
  // app's pulls list, whose title carries New pull.
  await page.getByRole("link", { name: "Open pull" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${appId}/pulls/new\\?base=main&head=feature`, "u")
  );
  await page
    .getByRole("list", { name: "Your apps" })
    .getByRole("link", { name: /^Pulls/u })
    .click();
  await expect(page).toHaveURL(new RegExp(`/apps/${appId}/pulls$`, "u"));
  await expect(page.getByText("No open pulls.")).toBeVisible();
  await expect(page.getByRole("link", { name: "New pull" })).toHaveAttribute(
    "href",
    `/apps/${appId}/pulls/new`
  );

  // The picker's creator branches off the browsed ref and switches to it;
  // the admin deletes it from the same list.
  await page.goto(`/apps/${appId}/source?ref=feature`);
  await page.getByLabel("Branch or ref").click();
  await page.getByLabel("New branch name").fill("topic");
  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await expect(page).toHaveURL(/ref=topic/u, { timeout: 30_000 });
  await page.getByLabel("Branch or ref").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete branch topic" }).click();
  await expect(page.getByRole("button", { name: /^topic\b/u })).toBeHidden({
    timeout: 30_000,
  });
});

test("a deployment links to its commit page", async ({ page, request }) => {
  // Only main deploys; the feature branch push alongside it is ignored, so
  // the main sha is the deployment tip this test looks for.
  createdApps.push(`${FORGE_SLUG}-deploy`);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Forge Deploy",
    slug: `${FORGE_SLUG}-deploy`,
  });
  const { main } = pushMainAndFeature(
    apiKey,
    new URL("../test", import.meta.url),
    `${FORGE_SLUG}-deploy`
  );
  await page.goto(`/apps/${appId}?t=deployments`);
  const link = page.getByRole("link", { name: main.slice(0, 12) });
  await expect(link).toBeVisible({ timeout: 5 * 60_000 });
  await link.click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${appId}/source/commit/${main}`, "u")
  );
});
