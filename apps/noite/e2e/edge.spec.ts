import { CONTROL_HOST_DENIED_ASSETS } from "$lib/preview-host";
import { expect, test } from "@playwright/test";

// Raw-port lane: the control UI through Caddy on the lane's `*.localhost` base
// (http://noite.localhost:8090), the runner API/git on raw :8080, tenant
// fleets on their own ports. A host, never 127.0.0.1: the WebAuthn RP ID has
// to match the origin.
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

test("control UI is cross-origin isolated", async ({ page, request }) => {
  // The TypeScript language service passes `SharedArrayBuffer` to workers, so
  // every document (and the worker scripts it loads) must carry COOP/COEP or
  // the browser refuses to expose it.
  await page.goto("/login");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  // The workspace — its code, its workers, its preview service worker — belongs
  // to the app's preview origin, never this one. Every pod path is absent here:
  // nothing on the control origin may create a process worker or register a
  // service worker, or app-controlled code would run in this page's agent
  // cluster, with the viewer's session.
  const answers = await Promise.all(
    CONTROL_HOST_DENIED_ASSETS.map(async (path) => {
      const res = await request.get(path);

      return `${path} -> ${res.status()}`;
    })
  );

  expect(answers).toEqual(
    CONTROL_HOST_DENIED_ASSETS.map((path) => `${path} -> 404`)
  );
});

test("control UI still serves its own bundle", async ({ request }) => {
  // `/assets/*` is both the control UI's bundle and, on the preview host, the
  // frame bundle's chunks: the pod route must decline it here so the platform
  // serves these scripts exactly as it always has.
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
