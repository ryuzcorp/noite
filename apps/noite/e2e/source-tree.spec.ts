import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp, pushAppDir } from "./helpers";

// The tree's own gestures: the context menu adds, renames and deletes rows,
// and an upload adds a binary one. Every gesture is a change in the page's
// session, and one Push commits them.

/** Every app this spec creates, dropped after the file: the account's app
 * quota (10) is shared by the whole lane. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

const changesBadge = (page: Page) =>
  page.getByRole("button", { name: /^Changes/u }).locator(".badge");

/** Right-click below the rows: the tree's root menu. */
const openRootMenu = async (page: Page): Promise<void> => {
  const tree = page.locator(".noite-src-tree");
  const box = await tree.boundingBox();

  if (box === null) {
    throw new TypeError("the tree column has no box");
  }

  // The tree's own element, right button: `page.mouse.click` would be a left
  // click, which opens no menu at all.
  await tree.click({
    button: "right",
    position: { x: box.width / 2, y: box.height - 12 },
  });
};

// New File parks a placeholder row that pierre names in place; Delete stages a
// deletion. Both are session changes — the added file is written by the commit,
// the deleted one goes in its `deletes` — and one Push commits the pair.
test("the tree menu adds and deletes a file, and one Push commits both", async ({
  page,
  request,
}) => {
  const slug = "source-tree-menu";
  createdApps.push(slug);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Menu",
    slug,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), slug);

  await page.goto(`/apps/${appId}/source?ref=main&panel=changes`);
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeVisible();

  await openRootMenu(page);
  await page.getByRole("menuitem", { name: "New File" }).click();
  await page.locator("[data-item-rename-input]").fill("extra.ts");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("treeitem", { name: "extra.ts" })).toBeVisible();

  // The new file opens ready to type in, and its text is a change. Focused
  // directly: a pointer click can land on pierre's gutter overlay (which
  // intercepts it) for a file shorter than the pane.
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await editor.focus();
  await page.keyboard.type("export const extra = 1;");

  // Delete util.ts through its own row menu, one confirmation for the row.
  await page
    .getByRole("treeitem", { name: "util.ts" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete util.ts?" });
  await confirm.getByRole("button", { exact: true, name: "Delete" }).click();

  await expect(changesBadge(page)).toHaveText("2");

  const panel = page.getByRole("complementary", { name: "Changes" });
  await panel.getByLabel("Commit message").fill("Add extra, drop util");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();

  await expect(changesBadge(page)).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole("treeitem", { name: "extra.ts" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeHidden();
});

// An inline rename is a move: the commit carries it as `moves`, so the blob
// keeps its bytes and the file just changes path. Discard puts the row back.
test("renaming a row is a move the commit carries", async ({
  page,
  request,
}) => {
  const slug = "source-tree-rename";
  createdApps.push(slug);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Rename",
    slug,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), slug);

  await page.goto(`/apps/${appId}/source?ref=main&panel=changes`);
  const util = page.getByRole("treeitem", { name: "util.ts" });
  await expect(util).toBeVisible();

  await util.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.locator("[data-item-rename-input]").fill("helpers.ts");
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("treeitem", { name: "helpers.ts" })
  ).toBeVisible();
  await expect(changesBadge(page)).toHaveText("1");

  const panel = page.getByRole("complementary", { name: "Changes" });
  await expect(
    panel.getByRole("list", { name: "Changed files" })
  ).toContainText("util.ts → helpers.ts");

  await panel.getByLabel("Commit message").fill("Rename util to helpers");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();

  await expect(changesBadge(page)).toBeHidden({ timeout: 60_000 });
  await expect(
    page.getByRole("treeitem", { name: "helpers.ts" })
  ).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeHidden();
});

// An upload is bytes, not text: the row shows its size where a diff would be,
// and the commit carries it base64.
test("an uploaded file is a binary row the commit carries", async ({
  page,
  request,
}) => {
  const slug = "source-tree-upload";
  createdApps.push(slug);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Upload",
    slug,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), slug);

  await page.goto(`/apps/${appId}/source?ref=main&panel=changes`);
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeVisible();

  await openRootMenu(page);
  await page.getByRole("menuitem", { name: "Upload files…" }).click();
  await page.locator('input[data-source-upload="true"]').setInputFiles({
    buffer: Buffer.from("not text \u0000 at all"),
    mimeType: "application/octet-stream",
    name: "blob.bin",
  });

  await expect(page.getByRole("treeitem", { name: "blob.bin" })).toBeVisible();
  await expect(changesBadge(page)).toHaveText("1");

  const panel = page.getByRole("complementary", { name: "Changes" });
  const row = panel.getByRole("list", { name: "Changed files" });
  await expect(row).toContainText("blob.bin");

  await panel.getByLabel("Commit message").fill("Add a blob");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();

  await expect(changesBadge(page)).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole("treeitem", { name: "blob.bin" })).toBeVisible();
});
