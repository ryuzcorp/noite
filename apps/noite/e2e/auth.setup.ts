import { expect, test as setup } from "@playwright/test";

import { E2E_EMAIL, E2E_NAME, addVirtualAuthenticator } from "./helpers";

const authFile = "e2e/.auth/user.json";

/** Register the e2e account via passkey (virtual authenticator) and persist
 * the session for the e2e project. Registration creates the session
 * directly (`createSession: true`), so no sign-in round-trip is needed.
 * The fresh account is un-onboarded, so walk (and finish) the onboarding
 * modal first: every later spec then runs with an onboarded user and
 * `createAppWithKey` is not blocked by the modal. */
setup("register e2e account", async ({ page }) => {
  await addVirtualAuthenticator(page);
  await page.goto("/login");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.locator("#register-name").fill(E2E_NAME);
  await page.locator("#register-email").fill(E2E_EMAIL);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(async () => {
    const res = await page.request.get("/api/auth/get-session");
    // SAFETY: better-auth get-session answers { user } on success (verified ok above).
    const body = (await res.json()) as {
      user?: { email?: string };
    };
    expect(body.user?.email).toBe(E2E_EMAIL);
  }).toPass({ timeout: 30_000 });

  // First-run onboarding: mark this account onboarded so the modal never
  // shows in the later specs.
  await page.goto("/apps");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.locator("#onboarding-next").click();
  await page.locator("#onboarding-next").click();
  await expect(page.locator("#onboarding-sponsor")).toHaveAttribute(
    "href",
    "https://github.com/sponsors/ryuzdev"
  );
  await page.locator("#onboarding-finish").click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.context().storageState({ path: authFile });
});
