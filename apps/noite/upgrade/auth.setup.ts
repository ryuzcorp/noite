import { expect, test as setup } from "@playwright/test";

import {
  E2E_EMAIL,
  E2E_NAME,
  addVirtualAuthenticator,
  finishOnboarding,
} from "../e2e/helpers";

const authFile = process.env.E2E_AUTH_DIR
  ? `${process.env.E2E_AUTH_DIR}/user.json`
  : "upgrade/.auth/user.json";

// The verify phase reuses the seed phase's session; registering again would
// fail (the account already exists).
setup.skip(
  process.env.UPGRADE_PHASE === "verify",
  "account is registered in the seed phase"
);

/** Register the upgrade lane's account (same flow as `e2e/auth.setup.ts`,
 * but writing the lane's own slot-scoped auth file): the seed and the
 * verify run in two separate Playwright invocations, and both read this
 * session. Registration creates the session directly, so no sign-in
 * round-trip is needed. */
setup("register upgrade account", async ({ page }) => {
  await addVirtualAuthenticator(page);
  await page.goto("/login");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.locator("#register-name").fill(E2E_NAME);
  await page.locator("#register-email").fill(E2E_EMAIL);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(async () => {
    const res = await page.request.get("/api/auth/get-session");

    // SAFETY: better-auth get-session answers { user } on success.
    const body = (await res.json()) as {
      user?: { email?: string };
    };

    expect(body.user?.email).toBe(E2E_EMAIL);
  }).toPass({ timeout: 30_000 });

  await page.goto("/apps");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.locator("#onboarding-next").click();
  await page.locator("#onboarding-next").click();
  await expect(page.locator("#onboarding-sponsor")).toHaveAttribute(
    "href",
    "https://github.com/sponsors/ryuzdev"
  );

  await finishOnboarding(page);
  await page.context().storageState({ path: authFile });
});
