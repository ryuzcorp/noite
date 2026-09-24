import { expect, test } from "@playwright/test";

import {
  E2E_SLUG,
  appListenPort,
  findAppId,
  pushSampleApp,
  readSampleApp,
  waitForDeploy,
} from "./helpers";

// Full loop: create app → mint API key → git push → deploy → serve.
// Runs under the registered session (storageState from auth.setup).
test("push to deploy serves traffic", async ({ page, request }) => {
  await page.goto("/apps/new");
  await page.locator("#create-name").fill("E2E App");
  await page.locator("#create-slug").fill(E2E_SLUG);
  await page.getByRole("button", { name: "Create app" }).click();
  await page.waitForURL("**/apps", { timeout: 30_000 });

  const appId = await findAppId(request, E2E_SLUG);
  expect(appId).not.toBeNull();
  await page.goto("/profile");
  await page
    .locator('button[type="button"]', { hasText: "Create key" })
    .click();
  await page.locator("#key-name").fill("e2e-ci");
  await page
    .locator('button[type="submit"]', { hasText: "Create key" })
    .click();
  const keyBox = page.locator("text=Copy now — shown once");
  await expect(keyBox).toBeVisible({ timeout: 30_000 });
  const rawKey = await page.locator("code.break-all").first().textContent();
  const apiKey = rawKey?.trim() ?? "";
  expect(apiKey.length).toBeGreaterThan(0);

  pushSampleApp(apiKey);

  const deploy = await waitForDeploy(request, appId ?? "");
  expect(deploy.status).toBe("success");

  const port = await appListenPort(request, appId ?? "");
  const body = await readSampleApp(request, port);
  expect(Number.isInteger(body.n)).toBe(true);
});
