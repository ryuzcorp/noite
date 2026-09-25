import { expect, test } from "@playwright/test";

import { findAppId, runnerCall } from "./helpers";

// Custom domains, tenant env vars and app lifecycle, driven through the runner
// API the control UI uses. The app-detail panels that surface the same calls
// are a known-broken surface under celld (see SPEC.md: their actions stall), so
// the lane pins the behaviour at the API layer and the edge fallback here.
test("custom domains, env vars and deletion behave", async ({
  page,
  request,
}) => {
  await page.goto("/apps/new");
  await page.locator("#create-name").fill("Lifecycle");
  await page.locator("#create-slug").fill("lifecycle");
  await page.getByRole("button", { name: "Create app" }).click();
  await page.waitForURL("**/apps", { timeout: 30_000 });
  const appId = await findAppId(request, "lifecycle");
  expect(appId).not.toBeNull();
  const id = appId ?? "";

  // --- custom domains -----------------------------------------------------
  // Shape is validated, and a platform hostname is refused before insert.
  const invalid = await runnerCall(request, `/v1/apps/${id}/domains`, {
    body: { hostname: "not a host" },
    method: "POST",
  });
  expect(invalid.status).toBe(400);

  const platform = await runnerCall(request, `/v1/apps/${id}/domains`, {
    body: { hostname: "api.localhost" },
    method: "POST",
  });
  expect(platform.status).toBe(400);

  const added = await runnerCall(request, `/v1/apps/${id}/domains`, {
    body: { hostname: "probe.example.com" },
    method: "POST",
  });
  expect(added.status).toBe(200);
  expect(JSON.stringify(added.body)).toContain("probe.example.com");

  // One hostname belongs to one app: a second app cannot claim it.
  const other = await runnerCall(request, "/v1/apps", {
    body: { name: "Claimant", slug: "claimant" },
    method: "POST",
  });
  expect(other.status).toBe(201);
  // SAFETY: `POST /v1/apps` answers the created app object (201 above).
  const otherId = (other.body as { id?: string }).id ?? "";
  const conflict = await runnerCall(request, `/v1/apps/${otherId}/domains`, {
    body: { hostname: "probe.example.com" },
    method: "POST",
  });
  expect(conflict.status).toBe(409);

  const removed = await runnerCall(
    request,
    `/v1/apps/${id}/domains/probe.example.com`,
    { method: "DELETE" }
  );
  expect(removed.status).toBe(200);
  expect(JSON.stringify(removed.body)).not.toContain("probe.example.com");

  // --- tenant env vars ----------------------------------------------------
  const env = await runnerCall(request, `/v1/apps/${id}/env`, {
    body: { name: "E2E_FLAG", value: "1" },
    method: "POST",
  });
  expect(env.status).toBe(200);
  const listed = await runnerCall(request, `/v1/apps/${id}/env`);
  expect(JSON.stringify(listed.body)).toContain("E2E_FLAG");
  const dropped = await runnerCall(request, `/v1/apps/${id}/env/E2E_FLAG`, {
    method: "DELETE",
  });
  expect(dropped.status).toBe(200);

  // --- the edge fallback for a host with no app ---------------------------
  // No Caddy in this lane, so this asks the runner directly: the fallback page
  // is what a wildcard edge serves for an unknown tenant host.
  const fallback = await request.get("http://localhost:8080/v1/edge/fallback", {
    headers: { host: "nope.localhost" },
  });
  expect(fallback.status()).toBe(404);
  expect(await fallback.text()).toContain("no app for this slug");

  // --- deletion -----------------------------------------------------------
  const gone = await runnerCall(request, `/v1/apps/${id}`, {
    method: "DELETE",
  });
  expect([200, 204]).toContain(gone.status);
  expect(await findAppId(request, "lifecycle")).toBeNull();
});
