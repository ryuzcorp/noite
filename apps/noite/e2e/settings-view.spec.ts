import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp } from "./helpers";

// Settings is a view of its own, under the app in the sidebar, right below
// Pull requests — not a side panel and not an item in the app page's tab row.
// The old `?panel=settings` link still works: it redirects to the view and
// carries a `?section=` deep link along. Nothing here deploys, so it fits the
// fast gate.
const SLUG = `settings-view-${Date.now()}`;
const NAME = "Settings View";

const sidebarItems = (page: Page) =>
  page.getByRole("list", { exact: true, name: NAME }).getByRole("link");

test(
  "settings is a sidebar view under Pull requests, not a tab-bar item",
  { tag: "@fast" },
  async ({ page, request }) => {
    const { appId } = await createAppWithKey(page, request, {
      name: NAME,
      slug: SLUG,
    });

    try {
      await page.goto(`/apps/${appId}`);

      // The open app's sidebar menu: Settings is directly under Pull requests.
      await expect(sidebarItems(page)).toHaveText([
        /^App$/u,
        /^Code$/u,
        /^Pull requests/u,
        /^Settings$/u,
      ]);

      // …and the tab row no longer carries a Settings item, in either form.
      const tabs = page.getByRole("tablist");
      await expect(tabs).toBeVisible();
      await expect(tabs).not.toContainText("Settings");
      await expect(page.getByRole("button", { name: "Settings" })).toHaveCount(
        0
      );

      // The sidebar item opens the view; its own tab row is the sections.
      await sidebarItems(page).filter({ hasText: "Settings" }).click();
      await expect(page).toHaveURL(new RegExp(`/apps/${appId}/settings$`, "u"));
      await expect(
        page.getByRole("heading", { level: 1, name: "Settings" })
      ).toBeVisible();
      await expect(page.getByRole("tab", { name: "Identity" })).toHaveAttribute(
        "aria-selected",
        "true"
      );

      // A section is a tab and the URL is its deep link.
      await page.getByRole("tab", { name: "Domains" }).click();
      await expect(page).toHaveURL(/\?section=domains$/u);
      await expect(page.locator("#custom-domain-hostname")).toBeVisible();
      await expect(
        sidebarItems(page).filter({ hasText: "Settings" })
      ).toHaveAttribute("aria-current", "page");

      // An old side-panel link redirects, keeping its section.
      await page.goto(`/apps/${appId}?t=events&panel=settings&section=domains`);
      await expect(page).toHaveURL(
        new RegExp(`/apps/${appId}/settings\\?section=domains$`, "u")
      );
      await expect(page.locator("#custom-domain-hostname")).toBeVisible();

      // Without a section (or with an unknown one) the view opens on Identity.
      await page.goto(`/apps/${appId}?panel=settings&section=nope`);
      await expect(page).toHaveURL(new RegExp(`/apps/${appId}/settings$`, "u"));
      await expect(page.locator("#identity-name")).toBeVisible();
    } finally {
      await deleteApp(request, SLUG);
    }
  }
);
