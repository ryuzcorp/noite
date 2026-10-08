import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp, pushAppDir } from "./helpers";

// Browser edits across files: drafts survive opening another file, and one
// Push commits every edited file together. The page repaints on each
// `?file=` write; that once remounted the browser and dropped the drafts.

const SLUG = "source-edit";

/** Every app this spec creates, dropped after the file: the account's app
 * quota (10) is shared by the whole lane. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

/** Append a line to the open file. Clicking below the last line focuses the
 * content element (a click on a line is pierre's and takes no focus). */
const appendLine = async (page: Page, line: string): Promise<void> => {
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  const box = await editor.boundingBox();
  if (box === null) {
    throw new TypeError("the editor has no box");
  }
  await editor.click({ position: { x: 8, y: box.height - 8 } });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(line);
};

test("edits to several files push as one commit from the Changes panel", async ({
  page,
  request,
}) => {
  createdApps.push(SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Edit",
    slug: SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), SLUG);

  await page.goto(`/apps/${appId}/source?file=index.ts&ref=main`);
  await appendLine(page, "// edit in index");
  const changes = page.getByRole("button", { name: /^Changes/u });
  const changed = changes.locator(".badge");
  await expect(changed).toHaveText("1");

  // Opening another file keeps the first file's draft.
  await page.getByRole("treeitem", { name: "util.ts" }).click();
  await expect(page).toHaveURL(/file=util\.ts/u);
  await expect(changed).toHaveText("1");
  await appendLine(page, "// edit in util");
  await expect(changed).toHaveText("2");

  // Back on the first file, its draft is what the editor shows.
  await page.getByRole("treeitem", { name: "index.ts" }).click();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText("// edit in index");

  // The panel diffs both drafts; one Push commits them with the message.
  await changes.click();
  const panel = page.getByRole("complementary", { name: "Changes" });
  // The diff renders in pierre's shadow root: locate its spans, not the
  // panel's own text.
  for (const line of ["// edit in index", "// edit in util"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- two independent checks, in order.
    await expect(
      panel.locator("span", { hasText: line }).first()
    ).toBeVisible();
  }
  await panel.getByLabel("Commit message").fill("Edit two files");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();
  await expect(panel).toContainText("Pushed to main.", { timeout: 30_000 });
  await expect(changed).toBeHidden();
  await page.getByRole("button", { exact: true, name: "History" }).click();
  await expect(page.getByRole("link", { name: "Edit two files" })).toBeVisible({
    timeout: 30_000,
  });

  // A push to a new branch leaves main as it was: the editor drops the draft
  // and the panel offers the pull.
  await appendLine(page, "// edit on a branch");
  await expect(changed).toHaveText("1");
  await changes.click();
  await panel.getByLabel("Commit to").selectOption("new");
  await panel.getByLabel("New branch name").fill("topic");
  await panel.getByRole("button", { exact: true, name: "Push" }).click();
  await expect(panel).toContainText("Pushed to topic.", { timeout: 30_000 });
  await expect(panel.getByRole("link", { name: "Open a pull" })).toBeVisible();
  await expect(editor).not.toContainText("// edit on a branch");
});
