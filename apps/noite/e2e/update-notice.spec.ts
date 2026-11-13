import { expect, test } from "@playwright/test";

// Release-check toggle, on the control page's Settings tab
// (`/apps/_control?t=settings`) — where the instance-wide switches moved from
// `/account`'s retired Admin tab. The card explains exactly what the check
// fetches, and the opt-out persists. The banner itself is covered at the
// runner/API level (a stub feed through the test-only base-URL override) and
// by the banner unit test — the lane stays on the toggle.
test("the release-check toggle explains itself and persists the opt-out", async ({
  page,
}) => {
  // The old deep link redirects to the Settings tab rather than landing on a
  // tab that no longer exists.
  await page.goto("/account?t=admin");
  await expect(page).toHaveURL(/\/apps\/_control\?t=settings/u);

  // Both instance switches live here now.
  await expect(
    page.getByRole("heading", { name: "Instance settings" })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Telemetry" })).toBeVisible();

  const card = page.locator("section", {
    hasText: "Check for new Noite releases",
  });

  await expect(
    card.getByRole("heading", { name: "Release check" })
  ).toBeVisible();
  await expect(card.getByText("api.github.com")).toBeVisible();

  const box = card.getByRole("checkbox");
  // Opt-out: a fresh install checks.
  await expect(box).toBeChecked();

  await box.uncheck();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Release check setting saved.")).toBeVisible();
  await expect(box).not.toBeChecked();

  await page.reload();

  const reloaded = page.locator("section", {
    hasText: "Check for new Noite releases",
  });

  await expect(reloaded.getByRole("checkbox")).not.toBeChecked();

  // Leave the install as found: checking again.
  await reloaded.getByRole("checkbox").check();
  await reloaded.getByRole("button", { name: "Save" }).click();
  await expect(
    reloaded.getByText("Release check setting saved.")
  ).toBeVisible();
  await expect(reloaded.getByRole("checkbox")).toBeChecked();

  // `/account` is personal settings only: no Admin tab, no instance switches.
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Admin" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Instance settings" })
  ).toHaveCount(0);
});
