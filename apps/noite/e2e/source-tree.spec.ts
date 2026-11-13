import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

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

  // Every blob the pane asked for. The tree's inline add parks an `untitled`
  // row before the file exists, and its selection event (when the row is
  // added, or late from a tree a rebuild replaced) must not become a read:
  // the runner answers 404, and that answer landing after the add opened its
  // file painted `Internal error (HTTP 500)` over the editor (run
  // 43487945583).
  const reads: string[] = [];

  page.on("request", (sent) => {
    if (!sent.url().endsWith("/api/source/sourceBlob")) {
      return;
    }

    // SAFETY: the page's own `sourceBlob` action carries `{ appId, path,
    // ref }` (see `readBlob` in lib/source/browser.tsx).
    const body = sent.postDataJSON() as { path: string };

    reads.push(body.path);
  });

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
  // Only a path the session holds is readable: `untitled` is the placeholder
  // row the add parked, and no commit ever holds it.
  expect(reads).not.toContain("untitled");
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

// How far the code pane's own scroll container has scrolled: walk from the
// file header (in pierre's shadow root) to the nearest scrolling ancestor.
const paneScrollTop = (header: Locator): Promise<number> =>
  header.evaluate((el) => {
    let node: Node | null = el;

    while (node !== null) {
      if (node instanceof HTMLElement) {
        const overflow = getComputedStyle(node).overflowY;

        if (
          (overflow === "auto" || overflow === "scroll") &&
          node.scrollHeight > node.clientHeight + 8
        ) {
          return node.scrollTop;
        }
      }

      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }

    return 0;
  });

// No `?file=` means the repository's front door, not "no files": package.json
// opens and the URL follows in place (Back leaves the app, never the browse's
// own default). The file-name header then stays at the top of the pane while
// a long file scrolls under it.
test("a browse opens package.json by default, and the file header stays put", async ({
  page,
  request,
}) => {
  const slug = "source-tree-default";
  createdApps.push(slug);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Tree Default",
    slug,
  });

  pushAppDir(apiKey, new URL("../test", import.meta.url), slug);

  await page.goto(`/apps/${appId}/source?ref=main`);
  const header = page.locator("[data-diffs-header]").first();
  await expect(header).toContainText("package.json", { timeout: 60_000 });
  await expect
    .poll(() => new URL(page.url()).searchParams.get("file"))
    .toBe("package.json");

  await page.goBack();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .not.toContain("/source");

  await page.goto(`/apps/${appId}/source?ref=main&file=bun.lock`);
  const longHeader = page.locator("[data-diffs-header]").first();
  await expect(longHeader).toContainText("bun.lock", { timeout: 60_000 });

  const box = await longHeader.boundingBox();

  if (box === null) {
    throw new TypeError("the file header has no box");
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => paneScrollTop(longHeader)).toBeGreaterThan(0);

  const after = await longHeader.boundingBox();

  if (after === null) {
    throw new TypeError(
      "the file header left the page while the file scrolled"
    );
  }

  expect(Math.abs(after.y - box.y)).toBeLessThanOrEqual(2);
});
