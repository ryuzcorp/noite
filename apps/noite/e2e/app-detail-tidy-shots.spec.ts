import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp, waitForDeploy } from "./helpers";

// Temporary before/after screenshots for the app-detail tidy PR (deleted
// before merge): one blank app, every tenant tab, desktop + 390 px. The
// Analytics tab only exists after the change, so its shot is skipped when
// the tab is absent (the before run).
const SHOTS_DIR = process.env.SHOTS_DIR ?? "test-results-shots";
const PREFIX = process.env.SHOTS_PREFIX ?? "shot";
const SLUG = "tidy-shots";
const APP_NAME = "Tidy Shots";

const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({
    fullPage: false,
    path: `${SHOTS_DIR}/${PREFIX}-${name}.png`,
  });
};

test("app detail tidy screenshots", async ({ page, request }) => {
  test.setTimeout(10 * 60_000);

  const { appId } = await createAppWithKey(page, request, {
    name: APP_NAME,
    slug: SLUG,
  });

  try {
    await waitForDeploy(request, appId);

    const tabs = page.getByRole("tab");

    // --- desktop ---------------------------------------------------------
    await page.goto(`/apps/${appId}`);
    await expect(page.locator("h1")).toHaveText(APP_NAME);
    await shot(page, "overview-header");

    await page.getByRole("tab", { exact: true, name: "Metrics" }).click();
    await expect(page.getByText("No traffic recorded yet")).toBeVisible();
    await shot(page, "metrics");

    if ((await tabs.filter({ hasText: "Analytics" }).count()) > 0) {
      await page.getByRole("tab", { exact: true, name: "Analytics" }).click();
      await expect(page.getByText("to see the breakdown")).toBeVisible();
      await shot(page, "analytics");
    }

    await page.getByRole("tab", { exact: true, name: "Errors" }).click();
    await expect(page.getByText("No open errors")).toBeVisible();
    await shot(page, "errors");

    await page.getByRole("tab", { exact: true, name: "Events" }).click();
    await expect(page.getByText("Send events")).toBeVisible();
    await shot(page, "events");

    // --- 390 px ----------------------------------------------------------
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto(`/apps/${appId}`);
    await expect(page.locator("h1")).toHaveText(APP_NAME);
    await shot(page, "overview-header-mobile");

    await page.getByRole("tab", { exact: true, name: "Metrics" }).click();
    await expect(page.getByText("No traffic recorded yet")).toBeVisible();
    await shot(page, "metrics-mobile");

    if ((await tabs.filter({ hasText: "Analytics" }).count()) > 0) {
      await page.getByRole("tab", { exact: true, name: "Analytics" }).click();
      await expect(page.getByText("to see the breakdown")).toBeVisible();
      await shot(page, "analytics-mobile");
    }

    await page.getByRole("tab", { exact: true, name: "Errors" }).click();
    await expect(page.getByText("No open errors")).toBeVisible();
    await shot(page, "errors-mobile");

    await page.getByRole("tab", { exact: true, name: "Events" }).click();
    await expect(page.getByText("Send events")).toBeVisible();
    await shot(page, "events-mobile");
  } finally {
    await deleteApp(request, SLUG);
  }
});
