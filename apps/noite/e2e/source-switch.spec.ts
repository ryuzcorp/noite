import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp, pushAppDir } from "./helpers";

// Code mode's ref machine must always settle. A browse ends in the ref's own
// checkout or in the failure card with its Retry — never in the switch overlay
// ("Switching to <ref>…") standing over the panes: the machine's `Opening`
// had no transition out for a request it refused, and the frame's `open`
// answer is unbounded, so a lost one held the overlay forever.

const SLUG = "source-switch";
const DEAD_SLUG = "source-switch-dead";

/** The ref's archive, as the control page fetches it for the frame. */
const ARCHIVE = /\/source\/archive\?/u;

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

  // A reload opens the ref the URL names again, and settles the same way: the
  // worker's saved copy comes back from IndexedDB, so the frame's `open` is
  // answering for a pod that did not start cold.
  await page.reload();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(overlay(page)).toHaveCount(0);

  // A branch created in the picker switches the browser in place: the overlay
  // marks the switch and goes when the new checkout is under the panes.
  await page.getByLabel(/^Branch or ref:/u).click();
  const picker = page.locator(".dropdown-content");
  await picker.getByLabel("New branch name").fill("topic");
  await picker.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/ref=topic/u);
  await expect(overlay(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible();

  // And back to the ref it came from: the checkout the browser kept warm is
  // installed under the same panes, and the overlay clears again. `main` is
  // this app's default ref, so the param drops out of the URL rather than
  // naming it (see `searchParam`).
  await pickBranch(page, "main");
  await expect(page).not.toHaveURL(/[?&]ref=/u);
  await expect(page.getByLabel(/^Branch or ref: main/u)).toBeVisible();
  await expect(overlay(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(editor).toBeVisible();
});

test("a lost open answer ends in the failure card, and Retry recovers", async ({
  page,
  request,
}) => {
  createdApps.push(DEAD_SLUG);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Source Switch Dead",
    slug: DEAD_SLUG,
  });

  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), DEAD_SLUG);

  await page.goto(`/apps/${appId}/source?file=index.ts&ref=main`);
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(overlay(page)).toHaveCount(0);

  // The pod's `open` waits for the ref's archive, which this page fetches: a
  // fetch that never answers is exactly the answer that could be lost. The
  // frame takes the `open` and never gets a reply to it. Every archive is
  // held, and the checkout on screen already has its files.
  await page.route(ARCHIVE, () => {
    // Deliberately unanswered: the request stays pending for the page's life.
  });

  await page.getByLabel(/^Branch or ref:/u).click();
  const picker = page.locator(".dropdown-content");
  await picker.getByLabel("New branch name").fill("stuck");
  await picker.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/ref=stuck/u);

  // Bounded: the switch ends in the card the retry offers, never in an overlay
  // that never clears (see OPEN_DEADLINE_MS in `$lib/source/ref-view`).
  const card = page.getByRole("alert").filter({ hasText: "Could not open" });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card).toContainText("stuck");
  await expect(overlay(page)).toHaveCount(0);

  // The retry opens a frame of its own — the abandoned open is not queued
  // behind — and this time the archive answers.
  await page.unroute(ARCHIVE);
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(overlay(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "index.ts" })).toBeVisible({
    timeout: 60_000,
  });
});
