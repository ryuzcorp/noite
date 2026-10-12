import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp, pushAppDir } from "./helpers";

// The tree's own gestures: the context menu adds and deletes rows, and dragging
// a row into a folder moves it. Each gesture is a draft the Changes panel
// commits with a Push.

/** Every app this spec creates, dropped after the file: the account's app
 * quota (10) is shared by the whole lane. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

// The tree's own context menu: New File parks a row pierre names in place, and
// Delete drops a row. Both are drafts — the added file is written, the deleted
// one goes in the push's `deletes`, and one Push commits the pair.

const MENU_SLUG = "source-tree-menu";

test("the tree menu adds and deletes a file, and one Push commits both", async ({
  page,
  request,
}) => {
  createdApps.push(MENU_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Menu",
    slug: MENU_SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), MENU_SLUG);

  await page.goto(`/apps/${appId}/source?ref=main`);
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeVisible();

  // New File from the empty space below the rows (the tree's root).
  const tree = page.locator(".noite-src-tree");
  const box = await tree.boundingBox();
  if (box === null) {
    throw new TypeError("the tree column has no box");
  }
  await tree.click({
    button: "right",
    position: { x: 24, y: box.height - 16 },
  });
  await page.getByRole("menuitem", { name: "New File" }).click();
  // pierre's own inline input names the placeholder row.
  await page.locator("[data-item-rename-input]").fill("extra.ts");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("treeitem", { name: "extra.ts" })).toBeVisible();
  await expect(page).toHaveURL(/file=extra\.ts/u);

  // The new file opens in the pane with its caret in it: the pane hands a file
  // it just created the editor's focus, so typing needs no click (pierre only
  // takes text where its own caret sits).
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeFocused();
  await page.keyboard.type("export const extra = 1;");

  // Delete asks first, and Cancel keeps the file.
  const util = page.getByRole("treeitem", { name: "util.ts" });
  const tsconfig = page.getByRole("treeitem", { name: "tsconfig.json" });
  await util.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const single = page.getByRole("alertdialog", { name: "Delete util.ts?" });
  await expect(single).toContainText(
    "Push removes 1 file from the repository."
  );
  await single.getByRole("button", { name: "Cancel" }).click();
  await expect(single).toBeHidden();
  await expect(util).toBeVisible();

  // A right-click inside a Ctrl/Cmd multi-selection deletes all of it.
  await util.click();
  await tsconfig.click({ modifiers: ["ControlOrMeta"] });
  await util.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete (2)" }).click();
  const both = page.getByRole("alertdialog", { name: "Delete 2 items?" });
  await expect(both).toContainText("Push removes 2 files from the repository.");
  await both.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(util).toBeHidden();
  await expect(tsconfig).toBeHidden();

  const changes = page.getByRole("button", { name: /^Changes/u });
  await expect(changes.locator(".badge")).toHaveText("3");
  await changes.click();
  const panel = page.getByRole("complementary", { name: "Changes" });
  await expect(
    panel.locator("span", { hasText: "export const extra = 1;" }).first()
  ).toBeVisible();
  const rows = panel.getByRole("list", { name: "Changed files" });
  await expect(rows).toContainText("util.ts");
  await expect(rows).toContainText("tsconfig.json");
  await panel.getByLabel("Commit message").fill("Add extra, drop util");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();
  await expect(panel).toContainText("Pushed to main.", { timeout: 30_000 });
  // The stash is empty and the tree is the new commit: the file the push wrote
  // is there, the one it deleted is not.
  await expect(changes.locator(".badge")).toBeHidden();
  await expect(page.getByRole("treeitem", { name: "extra.ts" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeHidden();
});

// Dragging a row into a folder is a move draft: the panel reads the committed
// path against the new one, and one Push renames the file in the commit.

const MOVE_SLUG = "source-tree-move";

test("dragging a file into a folder pushes a move", async ({
  page,
  request,
}) => {
  createdApps.push(MOVE_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Move",
    slug: MOVE_SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), MOVE_SLUG);

  await page.goto(`/apps/${appId}/source?ref=main`);
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeVisible();

  // The fixture has no folder, so make one to drop into.
  const tree = page.locator(".noite-src-tree");
  const box = await tree.boundingBox();
  if (box === null) {
    throw new TypeError("the tree column has no box");
  }
  await tree.click({
    button: "right",
    position: { x: 24, y: box.height - 16 },
  });
  await page.getByRole("menuitem", { name: "New Folder" }).click();
  await page.locator("[data-item-rename-input]").fill("src");
  await page.keyboard.press("Enter");
  const folder = page.getByRole("treeitem", { name: "src" });
  await expect(folder).toBeVisible();

  // Drag the file onto the folder row: the row moves inside it (and the folder
  // has to be open to show the child, so the move is read off the panel).
  await page.getByRole("treeitem", { name: "util.ts" }).dragTo(folder);
  await expect(page.locator('[data-item-path="util.ts"]')).toHaveCount(0);

  const changes = page.getByRole("button", { name: /^Changes/u });
  await expect(changes.locator(".badge")).toHaveText("1");
  await changes.click();
  const panel = page.getByRole("complementary", { name: "Changes" });
  await expect(
    panel.getByRole("list", { name: "Changed files" })
  ).toContainText("util.ts → src/util.ts");

  await panel.getByLabel("Commit message").fill("Move util into src");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();
  await expect(panel).toContainText("Pushed to main.", { timeout: 30_000 });
  await expect(changes.locator(".badge")).toBeHidden();

  // The commit carries the file at its new home, text and all.
  await folder.click();
  await expect(page.locator('[data-item-path="src/util.ts"]')).toBeVisible();
  await expect(page.locator('[data-item-path="util.ts"]')).toHaveCount(0);
});

/** Append a line to the open file: a click on a line is pierre's, so the caret
 * is asked for by key before typing. */
const editOpenFile = async (page: Page, line: string): Promise<void> => {
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  const box = await editor.boundingBox();
  if (box === null) {
    throw new TypeError("the editor has no box");
  }
  await page.mouse.click(box.x + 8, box.y + box.height - 8);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(line);
};

// The keyboard and the panel: F2 renames a row (a move), Delete on the
// selection stages a removal, Discard throws an edit away, and the pod outlives
// a reload (the change lives in the browser's IndexedDB, not in the page).

const EDIT_SLUG = "source-tree-edit";

test("rename, discard and the delete key shape the stash", async ({
  page,
  request,
}) => {
  createdApps.push(EDIT_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Edit",
    slug: EDIT_SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), EDIT_SLUG);

  await page.goto(`/apps/${appId}/source?file=util.ts&ref=main`);
  const changes = page.getByRole("button", { name: /^Changes/u });
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  // No change yet: the header shows no status.
  const status = page.locator(".noite-src-change");
  await expect(status).toBeHidden();
  await changes.click();
  const panel = page.getByRole("complementary", { name: "Changes" });
  const rows = panel.getByRole("list", { name: "Changed files" });

  // Discard puts the file back to the commit's text.
  await editOpenFile(page, "// throw this away");
  await expect(changes.locator(".badge")).toHaveText("1");
  await expect(rows).toContainText("util.ts");
  // The editor's header carries the change the tree marks, from the same
  // workspace changes.
  await expect(status).toHaveText("M");
  await expect(status).toHaveAttribute("data-change-kind", "modified");
  await panel
    .getByRole("button", { exact: true, name: "Discard changes to util.ts" })
    .click();
  const discard = page.getByRole("alertdialog", {
    name: "Discard changes to util.ts?",
  });
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(changes.locator(".badge")).toBeHidden();
  await expect(editor).not.toContainText("// throw this away");
  // A discarded change leaves the header too.
  await expect(status).toBeHidden();

  // The pod outlives a reload: the change is written to IndexedDB as it is
  // made, so the reloaded page reads it back from there — and the header's
  // change status comes back with it.
  await editOpenFile(page, "// kept across reload");
  await expect(changes.locator(".badge")).toHaveText("1");
  await expect(status).toHaveText("M");
  await page.reload();
  await expect(changes.locator(".badge")).toHaveText("1", { timeout: 30_000 });
  await expect(page.locator('[contenteditable="true"]').first()).toContainText(
    "// kept across reload"
  );
  await expect(status).toHaveText("M", { timeout: 30_000 });
  await expect(status).toHaveAttribute("data-change-kind", "modified");

  // F2 renames the row: one move from the committed path.
  await page.getByRole("treeitem", { name: "util.ts" }).click();
  await page.keyboard.press("F2");
  await page.locator("[data-item-rename-input]").fill("tool.ts");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-item-path="tool.ts"]')).toBeVisible();
  await expect(page.locator('[data-item-path="util.ts"]')).toHaveCount(0);
  // The panel is still open: `?panel=changes` came back with the reload.
  await expect(changes).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toContainText("util.ts → tool.ts");

  // Delete on the selected row stages its removal.
  await page.getByRole("treeitem", { name: "index.ts" }).click();
  await page.keyboard.press("Delete");
  const removal = page.getByRole("alertdialog", { name: "Delete index.ts?" });
  await removal.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(page.locator('[data-item-path="index.ts"]')).toHaveCount(0);

  // One Push carries the rename and the removal.
  await panel.getByLabel("Commit message").fill("Rename util, drop index");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();
  await expect(panel).toContainText("Pushed to main.", { timeout: 30_000 });
  await expect(page.locator('[data-item-path="tool.ts"]')).toBeVisible();
  await expect(page.locator('[data-item-path="index.ts"]')).toHaveCount(0);
});

// Closing the page and opening a fresh one in the same browser context is the
// same pod (one IndexedDB workspace per app and branch, keyed by the origin):
// the change made by the closed page is what the fresh page restores, with no
// reload trickery.

const RESTART_SLUG = "source-tree-restart";

test("a change survives a tab restart, and Discard all clears it", async ({
  context,
  page,
  request,
}) => {
  createdApps.push(RESTART_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Restart",
    slug: RESTART_SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), RESTART_SLUG);

  const source = `/apps/${appId}/source?file=util.ts&ref=main`;
  await page.goto(source);
  await editOpenFile(page, "// kept across a tab restart");
  await expect(
    page.getByRole("button", { name: /^Changes/u }).locator(".badge")
  ).toHaveText("1");

  // The first page goes away entirely: its pod is handed back to IndexedDB and
  // its lock released, so the fresh page in this context reopens it editable.
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(source);

  // The pod is the same one, so the badge, the panel row and the editor all
  // read the change the closed page made.
  const changes = reopened.getByRole("button", { name: /^Changes/u });
  const editor = reopened.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText("// kept across a tab restart", {
    timeout: 60_000,
  });
  await expect(changes.locator(".badge")).toHaveText("1");
  await changes.click();
  const panel = reopened.getByRole("complementary", { name: "Changes" });
  await expect(
    panel.getByRole("list", { name: "Changed files" })
  ).toContainText("util.ts");

  // Discard all clears the pod: the panel and the editor are back to the
  // commit, with nothing left for the badge to count.
  await panel.getByRole("button", { exact: true, name: "Discard all" }).click();
  const discard = reopened.getByRole("alertdialog", {
    name: "Discard all changes?",
  });
  await discard
    .getByRole("button", { exact: true, name: "Discard all" })
    .click();
  await expect(changes.locator(".badge")).toBeHidden();
  await expect(panel.getByRole("list", { name: "Changed files" })).toHaveCount(
    0
  );
  await expect(editor).not.toContainText("// kept across a tab restart");

  // The discard is in the pod too: the edited text does not come back with a
  // reload. An empty badge is only evidence once the reloaded page has read
  // the pod back, so its editor is waited for before the absence is read.
  await reopened.reload();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(editor).not.toContainText("// kept across a tab restart");
  await expect(changes.locator(".badge")).toBeHidden();
  await reopened.close();
});

// Two live tabs on one branch are one workspace: either tab's edit shows up in
// the other, and when the tab that saves the pod closes, the other one takes
// over saving — its own later edit survives its reload.

const TABS_SLUG = "source-tree-tabs";

test("two tabs on one branch edit the same workspace", async ({
  context,
  page,
  request,
}) => {
  createdApps.push(TABS_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Tabs",
    slug: TABS_SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), TABS_SLUG);

  const source = `/apps/${appId}/source?file=util.ts&ref=main`;
  await page.goto(source);
  const first = page.locator('[contenteditable="true"]').first();
  await expect(first).toBeVisible({ timeout: 60_000 });
  const other = await context.newPage();
  await other.goto(source);
  const second = other.locator('[contenteditable="true"]').first();
  await expect(second).toBeVisible({ timeout: 60_000 });

  await editOpenFile(page, "// typed in the first tab");
  await expect(second).toContainText("// typed in the first tab", {
    timeout: 15_000,
  });
  await editOpenFile(other, "// typed in the second tab");
  await expect(first).toContainText("// typed in the second tab", {
    timeout: 15_000,
  });
  await expect(
    other.getByRole("button", { name: /^Changes/u }).locator(".badge")
  ).toHaveText("1");

  // The first tab saved the pod; once it is gone, the second one takes the
  // workspace's lock and saves from there. The lock lives with the pod, in the
  // tab's pod host frame on the app's preview origin. A change to a second file
  // shows in the badge only after the save it triggers has landed.
  await page.close();
  const podFrame = other
    .frames()
    .find((frame) => frame.url().includes("/noite-pod-host.html"));
  if (podFrame === undefined) {
    throw new TypeError("the second tab has no pod host frame");
  }
  await expect
    .poll(() =>
      podFrame.evaluate(async () => {
        const { held = [], pending = [] } = await navigator.locks.query();
        return (
          held.some((lock) => lock.name?.startsWith("nodepod-workspace:")) &&
          pending.length === 0
        );
      })
    )
    .toBe(true);
  await other.getByRole("treeitem", { name: "index.ts" }).click();
  await editOpenFile(other, "// after the first tab closed");
  await expect(
    other.getByRole("button", { name: /^Changes/u }).locator(".badge")
  ).toHaveText("2");
  await other.reload();
  await expect(
    other.getByRole("button", { name: /^Changes/u }).locator(".badge")
  ).toHaveText("2", { timeout: 60_000 });
  await other.getByRole("treeitem", { name: "index.ts" }).click();
  await expect(second).toContainText("// after the first tab closed");
  await other.getByRole("treeitem", { name: "util.ts" }).click();
  await expect(second).toContainText("// typed in the first tab");
  await other.close();
});

// Uploading from the computer: a file that is not text becomes a binary draft,
// which the panel reads by size and the push sends as base64.

const UPLOAD_SLUG = "source-tree-upload";

test("an uploaded binary lands in the tree and pushes", async ({
  page,
  request,
}) => {
  createdApps.push(UPLOAD_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Upload",
    slug: UPLOAD_SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), UPLOAD_SLUG);

  await page.goto(`/apps/${appId}/source?ref=main`);
  await expect(page.getByRole("treeitem", { name: "util.ts" })).toBeVisible();

  // "Upload files…" opens the picker; a NUL byte makes the file binary.
  const tree = page.locator(".noite-src-tree");
  const box = await tree.boundingBox();
  if (box === null) {
    throw new TypeError("the tree column has no box");
  }
  await tree.click({
    button: "right",
    position: { x: 24, y: box.height - 16 },
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload files…" }).click();
  const picked = await chooser;
  await picked.setFiles({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
    mimeType: "image/png",
    name: "logo.png",
  });
  await expect(page.locator('[data-item-path="logo.png"]')).toBeVisible();

  const changes = page.getByRole("button", { name: /^Changes/u });
  await expect(changes.locator(".badge")).toHaveText("1");
  await changes.click();
  const panel = page.getByRole("complementary", { name: "Changes" });
  const rows = panel.getByRole("list", { name: "Changed files" });
  await expect(rows).toContainText("logo.png");
  await expect(rows).toContainText("binary");

  await panel.getByLabel("Commit message").fill("Add logo");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();
  await expect(panel).toContainText("Pushed to main.", { timeout: 30_000 });
  await expect(changes.locator(".badge")).toBeHidden();
  await expect(page.locator('[data-item-path="logo.png"]')).toBeVisible();
});
