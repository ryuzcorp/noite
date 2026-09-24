import { expect, test } from "@playwright/test";

// Raw-port lane: no Caddy, no subdomains. Control UI direct on
// localhost:8090, runner API/git direct on localhost:8080. Plain
// `localhost` (never 127.0.0.1) so the WebAuthn RP ID validates.
test("control serves the UI", async ({ page }) => {
  // Authenticated sessions redirect /login to the app shell; either render
  // proves the worker serves the UI.
  await page.goto("/login");
  await expect(
    page
      .getByRole("button", { name: "Register" })
      .or(page.getByText("Your Apps"))
  ).toBeVisible();
});

test("runner api requires a token", async ({ request }) => {
  const res = await request.get("http://localhost:8080/v1/apps");
  expect(res.status()).toBe(401);
});

test("runner health is public", async ({ request }) => {
  const res = await request.get("http://localhost:8080/health");
  expect(res.ok()).toBe(true);
});

test("git smart-http is gated, not missing", async ({ request }) => {
  // ?service= routes past the "service required" 403 into the auth gate.
  const res = await request.get(
    "http://localhost:8080/v1/git/e2e/info/refs?service=git-upload-pack"
  );
  expect(res.status()).toBe(401);
});
