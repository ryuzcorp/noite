import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  pushAppDir,
  registerInviteeWithFreshCode,
} from "./helpers";

// Browser edits across files: the in-page buffers survive opening another
// file, and one Push commits every edited file together. The page repaints on
// each `?file=` write; that once remounted the browser and dropped the buffers.
//
// There is no persistence behind the buffers (Code mode holds them in the
// page), so these tests edit and commit in one visit; a reload is asserted to
// start clean in `source-switch`.

const SLUG = "source-edit";
const BRANCH_SLUG = "source-branch";
const PROTECTED_SLUG = "source-protected";

/** Every app this spec creates, dropped after the file: the account's app
 * quota (10) is shared by the whole lane. */
const createdApps: string[] = [];

/** The second browser the protection test signs into (closed after it). */
const contexts: BrowserContext[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

/** Append a line to the open file. The editor's text is a contenteditable
 * textbox, so it is focused directly: a pointer click can land on pierre's
 * gutter overlay (which intercepts it) when the file is shorter than the
 * pane. */
const appendLine = async (page: Page, line: string): Promise<void> => {
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(line);
};

const changesBadge = (page: Page) =>
  page.getByRole("button", { name: /^Changes/u }).locator(".badge");

test(
  "edits to two files commit as one change from the Changes panel",
  { tag: "@fast" },
  async ({ page, request }) => {
    createdApps.push(SLUG);

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "Source Edit",
      slug: SLUG,
    });

    pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), SLUG);

    await page.goto(
      `/apps/${appId}/source?file=index.ts&ref=main&panel=changes`
    );
    await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible({
      timeout: 60_000,
    });

    await appendLine(page, "export const first = 1;");

    // Another file's edit joins the first: both buffers are the page's, and
    // opening one does not drop the other.
    await page.getByRole("treeitem", { name: "util.ts" }).click();
    await expect(
      page.locator('[contenteditable="true"]').first()
    ).toContainText("util", { timeout: 60_000 });
    await appendLine(page, "export const second = 2;");

    await expect(changesBadge(page)).toHaveText("2");

    const panel = page.getByRole("complementary", { name: "Changes" });
    await expect(
      panel.getByRole("list", { name: "Changed files" }).getByRole("listitem")
    ).toHaveCount(2);

    await panel.getByLabel("Commit message").fill("Add two exports");
    await panel.getByRole("button", { exact: true, name: "Push" }).click();

    // The commit landed: the buffers are gone and the rows come back from the
    // branch's new tip, with both edits in it.
    await expect(changesBadge(page)).toBeHidden({ timeout: 60_000 });
    await page.getByRole("treeitem", { name: "util.ts" }).click();
    await expect(
      page.locator('[contenteditable="true"]').first()
    ).toContainText("export const second = 2;", { timeout: 60_000 });
    await page.getByRole("treeitem", { name: "index.ts" }).click();
    await expect(
      page.locator('[contenteditable="true"]').first()
    ).toContainText("export const first = 1;", { timeout: 60_000 });
  }
);

// A branch created from the commit form is started at the browsed tip, and the
// outcome line offers the pull request: the browser switches to the branch it
// just wrote.
test("a commit to a new branch lands and offers the pull request", async ({
  page,
  request,
}) => {
  createdApps.push(BRANCH_SLUG);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Branch",
    slug: BRANCH_SLUG,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), BRANCH_SLUG);

  await page.goto(`/apps/${appId}/source?file=index.ts&ref=main&panel=changes`);
  await appendLine(page, "// on a branch");
  await expect(changesBadge(page)).toHaveText("1");

  const panel = page.getByRole("complementary", { name: "Changes" });
  await panel.getByLabel("Commit to").selectOption(" new");
  await panel.getByLabel("New branch name").fill("topic");
  await panel.getByLabel("Commit message").fill("Add a branch line");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();

  const pull = panel.getByRole("link", { name: "Open a pull" });
  await expect(pull).toBeVisible({ timeout: 60_000 });
  await expect(pull).toHaveAttribute(
    "href",
    /\/pulls\/new\?base=main&head=topic/u
  );
  // The browser follows the branch it committed to.
  await expect(page).toHaveURL(/ref=topic/u);
  await expect(page.getByLabel(/^Branch or ref: topic/u)).toBeVisible();
});

// With `require_pr` on, `main` refuses a direct commit for anyone below
// admin: the target select disables it, says why, and the commit goes to a new
// branch instead — the only path the runner accepts. The rule never binds an
// admin, so this runs as a `push` collaborator (prs.spec covers the server-side
// refusal itself).
test("branch protection re-targets a push collaborator's commit", async ({
  browser,
  page,
  request,
}) => {
  createdApps.push(PROTECTED_SLUG);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Protected",
    slug: PROTECTED_SLUG,
  });

  pushAppDir(
    apiKey,
    new URL("fixtures/intel", import.meta.url),
    PROTECTED_SLUG
  );

  await page.goto(`/apps/${appId}/settings?section=branch-protection`);
  await page.locator("#branch-require-pr").check();
  await page.getByRole("button", { name: "Save branch rules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  const email = `code-push-${Date.now()}@example.com`;

  const invitee = await registerInviteeWithFreshCode(browser, page, {
    email,
    name: "Code Push",
  });

  contexts.push(invitee.context);

  await page.goto(`/apps/${appId}/settings?section=collaborators`);
  await page.getByRole("button", { exact: true, name: "Invite" }).click();
  await page.locator("#invite-email").fill(email);
  await page.locator("#invite-role").selectOption("push");
  await page
    .getByRole("dialog")
    .getByRole("button", { exact: true, name: "Invite" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await invitee.page.goto("/apps");
  await invitee.page
    .getByRole("button", { exact: true, name: "Accept" })
    .click();
  await expect(invitee.page).toHaveURL(new RegExp(`/apps/${appId}`, "u"));

  await invitee.page.goto(
    `/apps/${appId}/source?file=index.ts&ref=main&panel=changes`
  );
  await appendLine(invitee.page, "// protected");

  const panel = invitee.page.getByRole("complementary", { name: "Changes" });
  await expect(
    panel.getByText(
      "Protected branch: commit to a new branch and open a pull request."
    )
  ).toBeVisible({ timeout: 60_000 });

  // The disabled option is the refusal: the runner refuses `main` for a
  // push-role collaborator while the rule is on, so the form never offers it.
  const target = panel.getByLabel("Commit to");
  await expect(
    target.locator("option", { hasText: "main (protected)" })
  ).toBeDisabled();

  await panel.getByLabel("New branch name").fill("protected-change");
  await panel.getByLabel("Commit message").fill("Go around protection");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();

  await expect(panel.getByRole("link", { name: "Open a pull" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(invitee.page).toHaveURL(/ref=protected-change/u);
});
