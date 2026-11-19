import { expect, test } from "@playwright/test";

// Raw-port lane: the control UI through Caddy on the lane's `*.localhost` base,
// the runner API/git on the lane's raw API port, tenant fleets on their own
// ports. A host, never 127.0.0.1: the WebAuthn RP ID has to match the origin.
const apiBase = process.env.E2E_API_BASE ?? "http://localhost:8080";

test("control serves the UI", async ({ page }) => {
  // Authenticated sessions redirect /login to the app shell; either render
  // proves the worker serves the UI.
  await page.goto("/login");
  await expect(
    page
      .getByRole("tab", { name: "Create account" })
      .or(page.getByText("Your Apps", { exact: true }))
  ).toBeVisible();
});

test("control UI still serves its own bundle", async ({ request }) => {
  // `/assets/*` must reach Cello's own resolver, never the Worker: the pages
  // fallback would fetch them inside the app and its 15 s action bound.
  const response = await request.get("/login", {
    headers: { accept: "text/html" },
  });

  const html = await response.text();

  const entry =
    /src="(?<chunk>\/assets\/[^"]+)"/u.exec(html)?.groups?.chunk ?? "";

  expect(entry).not.toBe("");
  const asset = await request.get(entry);
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toContain("javascript");
});

test("runner api requires a token", { tag: "@fast" }, async ({ request }) => {
  const res = await request.get(`${apiBase}/v1/apps`);
  expect(res.status()).toBe(401);
});

test("runner health is public", async ({ request }) => {
  const res = await request.get(`${apiBase}/health`);
  expect(res.ok()).toBe(true);
});

test(
  "git smart-http is gated, not missing",
  { tag: "@fast" },
  async ({ request }) => {
    // ?service= routes past the "service required" 403 into the auth gate.
    const res = await request.get(
      `${apiBase}/v1/git/e2e/info/refs?service=git-upload-pack`
    );

    expect(res.status()).toBe(401);
  }
);

test(
  "every edge response carries Server: noite",
  { tag: "@fast" },
  async ({ request }) => {
    const edgeBase = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

    // Control UI through the edge (the runner API behind it is direct on
    // :8080 in this lane, so the UI proves the proxied path).
    const ui = await request.get(`${edgeBase}/login`, {
      headers: { accept: "text/html" },
    });

    expect(ui.ok()).toBe(true);
    expect(ui.headers()["server"]).toBe("noite");

    // Edge-rendered 404 for an unknown host: the route table answers, no
    // upstream is ever dialed, so this proves the edge's own pages too.
    const unknown = await request.get(`${edgeBase}/`, {
      headers: { host: "nope.noite.localhost" },
    });

    expect(unknown.status()).toBe(404);
    expect(unknown.headers()["server"]).toBe("noite");
  }
);
