import { expect, test as setup } from "@playwright/test";

import { E2E_EMAIL, E2E_NAME, addVirtualAuthenticator } from "./helpers";

const authFile = "e2e/.auth/user.json";

/** Register the e2e account via passkey (virtual authenticator) and persist
 * the session for the e2e project. Registration creates the session
 * directly (`createSession: true`), so no sign-in round-trip is needed. */
setup("register e2e account", async ({ page }) => {
  await addVirtualAuthenticator(page);
  await page.goto("/login");
  await page.getByRole("button", { name: "Register" }).click();
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
  await page.context().storageState({ path: authFile });
});
