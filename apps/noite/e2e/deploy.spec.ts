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
test(
  "push to deploy serves traffic",
  { tag: ["@fast", "@isolation"] },
  async ({ page, request }) => {
    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "E2E App",
      slug: E2E_SLUG,
    });

    // The Deployments tab is open before the push, so everything below must
    // arrive live, without a reload. The serving deploy opens on its
    // Deployment logs and the fleet's output streams in (the route once never
    // shipped, so the pane said "disconnected" forever); the page streams every
    // feed over one connection (`/api/streams`).
    const pageStream = page.waitForResponse(
      (res) =>
        res.url().includes("/api/streams?") &&
        res.url().includes(encodeURIComponent(`/api/apps/${appId}/logs/stream`))
    );

    await page.goto(`/apps/${appId}?t=deployments`);

    pushSampleApp(apiKey);

    const deploy = await waitForDeploy(request, appId);
    expect(deploy.status).toBe("success");

    const port = await appListenPort(request, appId);
    const body = await readSampleApp(request, port);
    expect(Number.isInteger(body.n)).toBe(true);

    // Every status badge on the page follows the deploy: the header and the
    // Production dot once stayed on "deploying" while the sidebar moved on.
    await expect(page.getByText("Running", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const production = page
      .locator("div")
      .filter({ has: page.getByText("Production", { exact: true }) })
      .last();

    await expect(production.locator(".status")).toHaveAttribute(
      "title",
      "running",
      { timeout: 15_000 }
    );
    await expect(
      page
        .getByRole("link", { exact: true, name: "E2E App" })
        .locator(".status")
    ).toHaveAttribute("title", "running", { timeout: 15_000 });

    const streamed = await pageStream;
    expect(streamed.status()).toBe(200);
    await expect(page.getByText("celld listening")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Log stream disconnected")).toBeHidden();

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
    // "Running" means the fleet is spawned, not yet listening: a read in that
    // gap is reset on the raw port, so give celld its boot before failing.
    await expect(async () => {
      const restarted = await readSampleApp(request, port);
      expect(Number.isInteger(restarted.n)).toBe(true);
    }).toPass({ timeout: 30_000 });

    // A dropdown closes once one of its items is clicked: SPA navigation used to
    // leave focus (and so the open menu) on the clicked item.
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("link", { exact: true, name: "Account" }).click();
    await expect(page).toHaveURL(/\/account$/u);
    await expect(
      page.getByRole("link", { exact: true, name: "Account" })
    ).toBeHidden();
  }
);
