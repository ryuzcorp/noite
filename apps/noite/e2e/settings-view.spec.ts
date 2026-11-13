import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  registerInviteeWithFreshCode,
} from "./helpers";

// Settings is a page of its own, under the app in the sidebar right below
// Pull requests — not a side panel and not an item in the app page's tab row.
// Every section the role may see is stacked on the one page, with its own
// heading; `?section=` scrolls to that heading instead of switching a tab,
// and the old `?panel=settings` link still redirects and keeps the section.
// Nothing here deploys, so it fits the fast gate.
const SLUG = `settings-view-${Date.now()}`;
const VIEWER_SLUG = `${SLUG}-viewer`;
const NAME = "Settings View";

const SECTION_HEADINGS = [
  "Identity",
  "Domains",
  "Limits",
  "Error reporting",
  "Collaborators",
  "Environment",
  "Branch protection",
  "Danger zone",
] as const;

const headings = (page: Page) => page.getByRole("heading", { level: 2 });

const sidebarItems = (page: Page) =>
  page.getByRole("list", { exact: true, name: NAME }).getByRole("link");

test(
  "every settings section stacks on one page and ?section= scrolls to it",
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

      // The sidebar item opens the page: every section is there at once, in
      // display order, with no tab row of sections.
      await sidebarItems(page).filter({ hasText: "Settings" }).click();
      await expect(page).toHaveURL(new RegExp(`/apps/${appId}/settings$`, "u"));
      await expect(
        page.getByRole("heading", { level: 1, name: "Settings" })
      ).toBeVisible();
      await expect(headings(page)).toHaveText([...SECTION_HEADINGS]);
      await expect(page.getByRole("tablist")).toHaveCount(0);

      // Each section kept its own panel and save flow: the admin sees the
      // forms, and all of them loaded without a tab switch.
      await Promise.all([
        expect(page.locator("#identity-name")).toBeVisible(),
        expect(page.locator("#custom-domain-hostname")).toBeVisible(),
        expect(page.locator("#limit-app")).toBeVisible(),
        expect(page.getByRole("button", { name: "Rotate key" })).toBeVisible(),
        expect(
          page.getByRole("button", { exact: true, name: "Invite" })
        ).toBeVisible(),
        expect(
          page.getByRole("button", { name: "Add Variable" })
        ).toBeVisible(),
        expect(page.locator("#branch-require-pr")).toBeVisible(),
        expect(
          page.getByRole("button", { exact: true, name: "Change slug" })
        ).toBeVisible(),
      ]);

      // The page has no in-page section nav: no tab strip, no contents
      // navigation above the sections.
      await expect(
        page.getByRole("navigation", { name: "Settings sections" })
      ).toHaveCount(0);

      // A shared link scrolls to its heading without switching anything.
      await page.goto(`/apps/${appId}/settings?section=danger`);
      await expect(
        page.getByRole("heading", { level: 2, name: "Danger zone" })
      ).toBeInViewport();
      await expect(
        page.getByRole("heading", { level: 2, name: "Identity" })
      ).not.toBeInViewport();

      // An old side-panel link redirects, keeping its section and scrolling.
      await page.goto(`/apps/${appId}?t=events&panel=settings&section=danger`);
      await expect(page).toHaveURL(
        new RegExp(`/apps/${appId}/settings\\?section=danger$`, "u")
      );
      await expect(
        page.getByRole("heading", { level: 2, name: "Danger zone" })
      ).toBeInViewport();

      // Without a section (or with an unknown one) the page opens at the top.
      await page.goto(`/apps/${appId}?panel=settings&section=nope`);
      await expect(page).toHaveURL(new RegExp(`/apps/${appId}/settings$`, "u"));
      await expect(
        page.getByRole("heading", { level: 2, name: "Identity" })
      ).toBeInViewport();
      await expect(
        page.getByRole("heading", { level: 2, name: "Danger zone" })
      ).not.toBeInViewport();
    } finally {
      await deleteApp(request, SLUG);
    }
  }
);

test(
  "a non-admin sees no admin-only section, and their link has no anchor",
  { tag: "@fast" },
  async ({ browser, page, request }) => {
    const { appId } = await createAppWithKey(page, request, {
      name: NAME,
      slug: VIEWER_SLUG,
    });

    const email = `settings-viewer-${Date.now()}@example.com`;

    const invitee = await registerInviteeWithFreshCode(browser, page, {
      email,
      name: "Settings Viewer",
    });

    try {
      // Invite the account as a viewer through the stacked page's
      // Collaborators section.
      await page.goto(`/apps/${appId}/settings?section=collaborators`);
      await page.getByRole("button", { exact: true, name: "Invite" }).click();
      await page.locator("#invite-email").fill(email);
      await page.locator("#invite-role").selectOption("view");
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

      await invitee.page.goto(`/apps/${appId}/settings`);
      await expect(invitee.page.getByRole("heading", { level: 2 })).toHaveText([
        "Identity",
        "Domains",
        "Limits",
        "Error reporting",
        "Collaborators",
        "Environment",
      ]);

      // A shared link to an admin-only section has no heading to scroll to,
      // and the read-only viewer gets no write controls.
      await invitee.page.goto(`/apps/${appId}/settings?section=danger`);
      await expect(
        invitee.page.getByRole("heading", { level: 2, name: "Identity" })
      ).toBeVisible();
      await expect(
        invitee.page.getByRole("heading", { name: "Danger zone" })
      ).toHaveCount(0);
      await expect(
        invitee.page.getByRole("heading", { name: "Branch protection" })
      ).toHaveCount(0);
      await expect(invitee.page.locator("#identity-name")).toBeDisabled();
      await expect(
        invitee.page.getByRole("button", { name: "Save name" })
      ).toHaveCount(0);
    } finally {
      await invitee.context.close();
      await deleteApp(request, VIEWER_SLUG);
    }
  }
);
