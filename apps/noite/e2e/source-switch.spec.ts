import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp, pushAppDir } from "./helpers";

// Code mode's ref machine must always settle. A browse ends in the ref's own
// files or in the failure card with its Retry — never in the switch overlay
// ("Switching to <ref>…") standing over the panes.
//
// The page holds the buffers: a ref switch with unsaved work asks first
// (`beforeunload` guards a page leave the same way), and a reload starts clean.

const SLUG = "source-switch";

/** Every app this spec creates, dropped after the file: the account's app
 * quota (10) is shared by the whole lane. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

/** The switch overlay is the view's own `Opening` made visible (see
 * `switchingTo` in `$lib/source/ref-view`): absent means the machine reached
 * `Ready` or `Failed`, and no other state paints it. */
const overlay = (page: Page) => page.locator("[data-source-switch]");

/** Pick a branch in the code-mode bar: the list's own row, so the browser
 * switches in place (a `?ref=` write, not a remount). */
const pickBranch = async (page: Page, name: string): Promise<void> => {
  await page.getByLabel(/^Branch or ref:/u).click();
  const list = page.getByRole("list", { name: "Branches and refs" });
  await list
    .getByRole("button", { name: new RegExp(`^${name}\\b`, "u") })
    .click();
};

/** Append a line to the open file (focused directly: a click can land on
 * pierre's gutter overlay for a short file). */
const appendLine = async (page: Page, line: string): Promise<void> => {
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(line);
};

/** Create a branch from the picker: the dropdown's own form, then Create. */
const createBranch = async (page: Page, name: string): Promise<void> => {
  await page.getByLabel(/^Branch or ref:/u).click();
  const picker = page.locator(".dropdown-content");
  await picker.getByLabel("New branch name").fill(name);
  await picker.getByRole("button", { name: "Create" }).click();
};

const changesBadge = (page: Page) =>
  page.getByRole("button", { name: /^Changes/u }).locator(".badge");

test("a browse settles, after a reload and after a branch switch", async ({
  page,
  request,
}) => {
  createdApps.push(SLUG);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Switch",
    slug: SLUG,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), SLUG);

  await page.goto(`/apps/${appId}/source?file=index.ts&ref=main`);
  const editor = page.locator('[contenteditable="true"]').first();

  // The first open ends on the checkout: rows, the file, no overlay.
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);

  // A reload opens the ref the URL names again and settles the same way. The
  // buffers are the page's, so nothing came back with it.
  await page.reload();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(overlay(page)).toHaveCount(0);
  await expect(changesBadge(page)).toBeHidden();

  // A branch created in the picker switches the browser in place: the overlay
  // marks the switch and goes when the new ref's files are under the panes.
  await page.getByLabel(/^Branch or ref:/u).click();
  const picker = page.locator(".dropdown-content");
  await picker.getByLabel("New branch name").fill("topic");
  await picker.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/ref=topic/u);
  await expect(overlay(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible();

  // And back: the checkout is read again, and the overlay clears.
  await pickBranch(page, "main");
  await expect(page).not.toHaveURL(/[?&]ref=/u);
  await expect(page.getByLabel(/^Branch or ref: main/u)).toBeVisible();
  await expect(overlay(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(editor).toBeVisible();
});

test("a ref switch with an unsaved buffer asks before throwing it away", async ({
  page,
  request,
}) => {
  const slug = "source-switch-dirty";
  createdApps.push(slug);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Switch Dirty",
    slug,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), slug);

  await page.goto(`/apps/${appId}/source?file=index.ts&ref=main&panel=changes`);
  await appendLine(page, "// unsaved");
  await expect(changesBadge(page)).toHaveText("1");

  // Cancel keeps the buffer and the ref: the picker goes back to what the
  // panes show.
  await createBranch(page, "topic");
  const ask = page.getByRole("alertdialog", { name: "Switch to topic?" });
  await expect(ask).toBeVisible({ timeout: 60_000 });
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toBeHidden();
  await expect(page.getByLabel(/^Branch or ref: main/u)).toBeVisible();
  await expect(changesBadge(page)).toHaveText("1");

  // Confirming discards the buffer and switches.
  await pickBranch(page, "topic");
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Discard and switch" }).click();
  await expect(page).toHaveURL(/ref=topic/u);
  await expect(overlay(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(changesBadge(page)).toBeHidden();
  await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible();
});

test("a failed open ends in the failure card, and Retry recovers", async ({
  page,
  request,
}) => {
  const slug = "source-switch-dead";
  createdApps.push(slug);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Switch Dead",
    slug,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), slug);

  await page.goto(`/apps/${appId}/source?file=index.ts&ref=main`);
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
    timeout: 60_000,
  });

  // The ref's listing is the one request an open cannot do without: failing it
  // is the failure card's own path, and the answer is an HTTP status, not a
  // dead frame.
  await page.route("**/api/source/sourceTree", (route) => route.abort());

  await page.getByLabel(/^Branch or ref:/u).click();
  const picker = page.locator(".dropdown-content");
  await picker.getByLabel("New branch name").fill("stuck");
  await picker.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/ref=stuck/u);

  const card = page.getByRole("alert").filter({ hasText: "Could not open" });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("stuck");
  await expect(overlay(page)).toHaveCount(0);

  await page.unroute("**/api/source/sourceTree");
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card).toHaveCount(0, { timeout: 60_000 });
  await expect(overlay(page)).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible({
    timeout: 60_000,
  });
});
