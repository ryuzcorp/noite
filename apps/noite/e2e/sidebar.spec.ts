import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp } from "./helpers";

// The sidebar is the shell's navigation: the live app list belongs on every
// page, not only on /apps, and it highlights the open app's own page. On a
// phone the drawer it lives in must get out of the way — every destination
// closes it, and Esc closes it from the keyboard with focus back on the
// toggle that opened it.
const SLUG = `sidebar-${Date.now()}`;
const NAME = "Sidebar Apps";
const DRAWER_SLUG = `${SLUG}-drawer`;
const DRAWER_NAME = "Sidebar Drawer";

/** The shell's app list (the /apps page has its own cards). */
const sidebarApps = (page: Page) =>
  page.getByRole("list", { name: "Your apps" });

/** One app's row in the sidebar. */
const appRow = (page: Page, name: string) =>
  sidebarApps(page).getByRole("link", { exact: true, name });

/** The open app's own submenu, named after the app. */
const appMenu = (page: Page, name: string) =>
  page.getByRole("list", { exact: true, name });

/** daisyUI's drawer checkbox: checked while the phone drawer is open. */
const drawer = (page: Page) => page.locator("#nav-drawer");

const menuToggle = (page: Page) =>
  page.getByRole("button", { name: "Open menu" });

/** The profile menu's items live in the sidebar, not on the page. */
const profileMenu = (page: Page) => page.getByRole("complementary");

test.afterAll(async ({ request }) => {
  await deleteApp(request, SLUG);
  await deleteApp(request, DRAWER_SLUG);
});

test("the app list is in the shell on every page and highlights the open app", async ({
  page,
  request,
}) => {
  const { appId } = await createAppWithKey(page, request, {
    name: NAME,
    slug: SLUG,
  });

  // Off the apps pages: the list is still there, and nothing in it claims to
  // be the current page.
  await page.goto("/account");
  await expect(appRow(page, NAME)).toBeVisible();
  await expect(sidebarApps(page).locator('[aria-current="page"]')).toHaveCount(
    0
  );

  // An app page expands the row and marks the part of the app the URL is in.
  await page.goto(`/apps/${appId}`);
  await expect(
    appMenu(page, NAME).getByRole("link", { exact: true, name: "App" })
  ).toHaveAttribute("aria-current", "page");

  await page.goto(`/apps/${appId}/settings`);
  await expect(
    appMenu(page, NAME).getByRole("link", { exact: true, name: "Settings" })
  ).toHaveAttribute("aria-current", "page");

  // Still live beside the page: renaming the app in Settings paints the new
  // name in the sidebar from the same stream, with no reload.
  await page.locator("#identity-name").fill(`${NAME} Renamed`);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(
    sidebarApps(page).getByRole("link", { name: `${NAME} Renamed` })
  ).toBeVisible();
});

test("the phone drawer closes on every destination and on Esc", async ({
  page,
  request,
}) => {
  const { appId } = await createAppWithKey(page, request, {
    name: DRAWER_NAME,
    slug: DRAWER_SLUG,
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/apps");

  // An app in the list: tapping it navigates and leaves the drawer closed.
  await menuToggle(page).click();
  await expect(drawer(page)).toBeChecked();
  await appRow(page, DRAWER_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${appId}$`, "u"));
  await expect(drawer(page)).not.toBeChecked();

  // The profile row opens its menu instead of closing the drawer; choosing a
  // destination in that menu closes both.
  await menuToggle(page).click();
  await expect(drawer(page)).toBeChecked();
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(
    profileMenu(page).getByRole("link", { name: "Account" })
  ).toBeVisible();
  await expect(drawer(page)).toBeChecked();
  await profileMenu(page).getByRole("link", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/account$/u);
  await expect(drawer(page)).not.toBeChecked();

  // Esc closes it and hands focus back to the toggle, so the keyboard user is
  // not left on a hidden item.
  await menuToggle(page).click();
  await expect(drawer(page)).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).not.toBeChecked();
  await expect(menuToggle(page)).toBeFocused();
});
