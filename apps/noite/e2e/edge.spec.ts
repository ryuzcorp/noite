import { expect, test } from "@playwright/test";

// Edge routing without auth: apex serves the UI, api./git. dispatch to the
// runner (401s prove the request reached the runner, not a worker 404).
test("apex serves the login page", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Register" })).toBeVisible();
});

test("runner api requires a token", async ({ request }) => {
  const res = await request.get("http://api.localhost:9080/v1/apps");
  expect(res.status()).toBe(401);
});

test("runner health is public", async ({ request }) => {
  const res = await request.get("http://api.localhost:9080/health");
  expect(res.ok()).toBe(true);
});

test("git smart-http is gated, not missing", async ({ request }) => {
  const res = await request.get("http://git.localhost:9080/e2e/info/refs");
  expect(res.status()).toBe(401);
});
