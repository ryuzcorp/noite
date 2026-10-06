import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The control plane as an app: the e2e account is the first account, so it
// bootstrapped as admin. Its Noite card opens the admin home, whose Overview
// lists the control D1; that opens the full table editor backed by the
// worker's own binding (never the runner). The mask, the per-table
// capabilities and the server-side filter/sort are the behaviours worth
// pinning: a session token must render masked, a read-only table must offer
// no write controls at all, and `invite` must round-trip an insert and an
// update through the row editor.
const CONTROL_STORAGE = "/storage/_control/d1%3Anoite-control";

/** The table rail of the editor. */
const tables = (page: Page) => page.getByRole("navigation", { name: "Tables" });

test("an admin browses the control D1 and edits a permitted row", async ({
  page,
}) => {
  await page.goto("/apps");

  // The control card sits above the user's own apps; it is not a runner app.
  const card = page.locator('a[href="/apps/_control"]').first();
  await expect(card).toBeVisible();
  await card.click();

  await expect(page.getByRole("heading", { name: "Noite" })).toBeVisible();
  await page.getByRole("link", { exact: true, name: "noite-control" }).click();
  await expect(page).toHaveURL(/\/storage\/_control\//u);

  const nav = tables(page);
  await expect(nav).toBeVisible();

  // `session` is delete-only: the token is masked, Insert is refused, and
  // the row editor opens read-only with just Delete.
  await nav.getByRole("button", { name: /^session\b/u }).click();
  await expect(page.getByText("•••• redacted").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Insert" })).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: "Select all rows on this page" })
  ).toBeVisible();
  await page.locator("tbody tr").first().click();
  const editor = page.getByRole("dialog");
  await expect(
    editor.getByRole("heading", { name: /View row/u })
  ).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "Delete row" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();

  // An auth table with no allowed write offers no write controls at all
  // (`passkey` always holds the e2e account's passkey; `account` can be empty).
  await nav.getByRole("button", { name: /^passkey\b/u }).click();
  await expect(page.getByRole("button", { name: "Insert" })).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: "Select all rows on this page" })
  ).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.locator("tbody tr").first().click();
  await expect(page.getByRole("heading", { name: /View row/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete row" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A permitted write: insert an invite through the row editor, then rewrite
  // its note from the grid.
  await nav.getByRole("button", { name: /^invite\b/u }).click();
  await page.getByRole("button", { name: "Insert" }).click();
  await expect(
    page.getByRole("heading", { name: /Insert row/u })
  ).toBeVisible();
  await page.locator("#d1-field-invite-code").fill("E2E-CONTROL-1");
  await page.locator("#d1-field-invite-createdBy").fill("e2e");
  await page.locator("#d1-field-invite-note").fill("e2e note");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Row created")).toBeVisible();
  await expect(page.getByRole("cell", { name: "E2E-CONTROL-1" })).toBeVisible();

  const row = page.locator("tbody tr", { hasText: "E2E-CONTROL-1" });
  await row.getByRole("cell").nth(1).click();
  await expect(
    page.getByRole("heading", { name: /Update row/u })
  ).toBeVisible();
  await page.locator("#d1-field-invite-note").fill("e2e note updated");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Row updated")).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "e2e note updated" })
  ).toBeVisible();

  // Server-side filter, then a header-click sort (asc → desc).
  const popover = page.locator("#d1-filter-popover");
  await popover.locator("summary").click();
  await popover.getByRole("button", { name: "Add" }).click();
  await popover.getByLabel("Filter column").selectOption("code");
  await popover.getByLabel("Operator").selectOption("eq");
  await popover.getByLabel("Filter value").fill("E2E-CONTROL-1");
  await popover.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/[?&]f=/u);
  await expect(page.locator("tbody tr")).toHaveCount(1);

  await page.getByRole("button", { name: /^code\b/u }).click();
  await expect(page).toHaveURL(/sort=code%3Aasc/u);
  await page.getByRole("button", { name: /^code\b/u }).click();
  await expect(page).toHaveURL(/sort=code%3Adesc/u);

  // The Definition view describes the same table.
  await page.getByRole("button", { name: "Definition" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Nullable" })
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Default" })
  ).toBeVisible();
  await expect(page.getByText(/CREATE TABLE/u)).toBeVisible();
  await page.getByRole("button", { name: "Data" }).click();
  await expect(page.getByRole("button", { name: "Insert" })).toBeEnabled();
});

// Every raw user/invite row links to the admin action that owns it, with that
// tab's search pre-filled from the row.
test("a raw row links to the proper admin action", async ({ page }) => {
  await page.goto(CONTROL_STORAGE);
  const nav = tables(page);
  await expect(nav).toBeVisible();

  await nav.getByRole("button", { name: /^user\b/u }).click();
  const manage = page.getByRole("link", { name: "Manage in Users" }).first();
  await expect(manage).toBeVisible();
  await manage.click();

  await expect(page).toHaveURL(/\/apps\/_control\?.*t=users/u);
  await expect(page.locator("#admin-user-search")).toHaveValue(/@/u);
});

// `<details>` popovers close on a click outside them and on Esc, not only
// when their own button is clicked again.
test("toolbar popovers dismiss on outside click and Esc", async ({ page }) => {
  await page.goto(CONTROL_STORAGE);
  await expect(tables(page)).toBeVisible();
  const popover = page.locator("#d1-filter-popover");
  const content = popover.locator(".dropdown-content");

  await popover.locator("summary").click();
  await expect(content).toBeVisible();
  await page.getByText(/^\d+ tables$/u).click();
  await expect(content).toBeHidden();

  await popover.locator("summary").click();
  await expect(content).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(content).toBeHidden();
});
