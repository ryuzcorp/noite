import { expect, test } from "@playwright/test";

import {
  E2E_SLUG,
  appListenPort,
  createAppWithKey,
  pushSampleApp,
  readSampleApp,
  waitForDeploy,
} from "./helpers";

// Full loop: create app → mint API key → git push → deploy → serve.
// Runs under the registered session (storageState from auth.setup).
test("push to deploy serves traffic", async ({ page, request }) => {
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "E2E App",
    slug: E2E_SLUG,
  });

  pushSampleApp(apiKey);

  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status).toBe("success");

  const port = await appListenPort(request, appId);
  const body = await readSampleApp(request, port);
  expect(Number.isInteger(body.n)).toBe(true);

  // The header's Stop/Start button reaches the runner: the desired state flips
  // and the status converges (Stop was once a silent no-op).
  await page.goto(`/apps/${appId}`);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Running", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const restarted = await readSampleApp(request, port);
  expect(Number.isInteger(restarted.n)).toBe(true);

  // A dropdown closes once one of its items is clicked: SPA navigation used to
  // leave focus (and so the open menu) on the clicked item.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("link", { exact: true, name: "Account" }).click();
  await expect(page).toHaveURL(/\/account$/u);
  await expect(
    page.getByRole("link", { exact: true, name: "Account" })
  ).toBeHidden();
});
