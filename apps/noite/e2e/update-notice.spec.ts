import { expect, test } from "@playwright/test";

// Release-check toggle (`/account` Admin tab): the card explains exactly
// what the check fetches, and the opt-out persists. The banner itself is
// covered at the runner/API level (a stub feed through the test-only
// base-URL override) and by the banner unit test — the lane stays on the
// toggle.
test("the release-check toggle explains itself and persists the opt-out", async ({
  page,
}) => {
  await page.goto("/account?t=admin");

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
});
