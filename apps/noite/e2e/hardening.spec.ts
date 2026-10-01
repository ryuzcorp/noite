import { expect, test } from "@playwright/test";

import { E2E_EMAIL, findAppId, runnerCall } from "./helpers";

// Control-plane hardening, pinned at the HTTP layer (the same layer the
// lifecycle spec uses, because the action-driven panels are a known-broken
// surface under celld — see SPEC.md). Unit tests in src/**/*.test.ts cover the
// role gate, invitations and rate limiter against a real SQLite; this lane
// proves the pieces are wired into the deployed worker.
const control = process.env.E2E_BASE_URL ?? "http://localhost:8090";

test("/health reports a build id stamped at build time", async ({
  request,
}) => {
  const res = await request.get(`${control}/health`);
  expect(res.ok()).toBe(true);
  // SAFETY: the route answers exactly this shape (see handleHealth).
  const body = (await res.json()) as { build: unknown; ok: boolean };
  expect(body.ok).toBe(true);
  // A git sha (or ISO time), not the old hand-bumped counter.
  expect(body.build).toEqual(expect.any(String));
});

test("/webhook proxies nothing for a caller without the runner token", async ({
  request,
}) => {
  const anonymous = await request.post(`${control}/webhook`, { data: {} });
  expect(anonymous.status()).toBe(401);
  const guessed = await request.post(`${control}/webhook`, {
    data: {},
    headers: { authorization: "Bearer not-the-token" },
  });
  expect(guessed.status()).toBe(401);
});

test("an emailed code cannot create an account that skips the invite gate", async ({
  playwright,
}) => {
  // A brand-new context: no session, no passkey.
  const anonymous = await playwright.request.newContext({
    baseURL: control,
    storageState: { cookies: [], origins: [] },
  });
  const email = `stranger-${Date.now()}@example.com`;
  // Requesting a code answers the same for any address (no enumeration)...
  const sent = await anonymous.post(
    "/api/auth/email-otp/send-verification-otp",
    {
      data: { email, type: "sign-in" },
    }
  );
  expect([200, 500]).toContain(sent.status());
  // ...but no code signs an unknown address in, or provisions it.
  const attempt = await anonymous.post("/api/auth/sign-in/email-otp", {
    data: { email, otp: "000000" },
  });
  expect(attempt.ok()).toBe(false);
  const session = await anonymous.get("/api/auth/get-session");
  // SAFETY: better-auth answers the session object or null.
  const body = (await session.json()) as { user?: { email?: string } } | null;
  expect(body?.user?.email).toBeUndefined();
  await anonymous.dispose();
});

test("the metrics stream honours ?hours= and pauses between polls", async ({
  page,
  request,
}) => {
  await page.goto("/apps/new");
  await page.locator("#create-name").fill("Hardening");
  await page.locator("#create-slug").fill("hardening");
  await page.getByRole("button", { name: "Create app" }).click();
  await page.waitForURL("**/apps", { timeout: 30_000 });
  const appId = (await findAppId(request, "hardening")) ?? "";
  expect(appId).not.toBe("");

  // Read the SSE stream for a few seconds from inside the page (it carries
  // the session cookie) and count what arrives.
  const observed = await page.evaluate(async (id) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 4000);
    let chunks = 0;
    let type = "";
    try {
      const res = await fetch(`/api/apps/${id}/metrics/stream?hours=168`, {
        signal: controller.signal,
      });
      type = res.headers.get("content-type") ?? "";
      const reader = res.body?.getReader();
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential stream read
        const { done } = (await reader?.read()) ?? { done: true };
        if (done) {
          break;
        }
        chunks += 1;
      }
    } catch {
      // Aborted after the observation window.
    }
    clearTimeout(timer);
    return { chunks, type };
  }, appId);
  expect(observed.type).toContain("text/event-stream");
  // First frame plus at most a heartbeat; a spinning loop would deliver
  // hundreds of chunks (or none, if it starved the response).
  expect(observed.chunks).toBeGreaterThanOrEqual(1);
  expect(observed.chunks).toBeLessThanOrEqual(4);

  const cleanup = await runnerCall(request, `/v1/apps/${appId}`, {
    method: "DELETE",
  });
  expect([200, 204]).toContain(cleanup.status);
});

test("/internal/recovery mints a code only for the runner token, and it signs in", async ({
  playwright,
  request,
}) => {
  const anonymous = await request.post(`${control}/internal/recovery`, {
    data: {},
  });
  expect(anonymous.status()).toBe(401);

  const token = process.env.E2E_RUNNER_TOKEN ?? "";
  const minted = await request.post(`${control}/internal/recovery`, {
    data: { email: E2E_EMAIL },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(minted.status()).toBe(200);
  // SAFETY: the route answers exactly this shape (see handleRecovery).
  const { code } = (await minted.json()) as { code: string };
  expect(code).toMatch(/^\d{6}$/u);

  // A brand-new context (no session, no passkey) signs in with the code, the
  // way the "Lost passkey?" screen does.
  const fresh = await playwright.request.newContext({
    baseURL: control,
    storageState: { cookies: [], origins: [] },
  });
  const signedIn = await fresh.post("/api/auth/sign-in/email-otp", {
    data: { email: E2E_EMAIL, otp: code },
  });
  expect(signedIn.ok()).toBe(true);
  const session = await fresh.get("/api/auth/get-session");
  // SAFETY: better-auth answers the session object or null.
  const body = (await session.json()) as { user?: { email?: string } } | null;
  expect(body?.user?.email).toBe(E2E_EMAIL);
  await fresh.dispose();
});
