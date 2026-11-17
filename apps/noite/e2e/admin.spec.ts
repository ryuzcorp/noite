import { expect, test } from "@playwright/test";
import type {
  APIRequestContext,
  APIResponse,
  BrowserContext,
  Page,
} from "@playwright/test";

import {
  addVirtualAuthenticator,
  appListenPort,
  createAppWithKey,
  createEmailInviteLink,
  deleteApp,
  findAppId,
  inviteTokenOf,
  pushAppDir,
  readSampleApp,
  registerInviteeAccount,
  runnerApi,
  waitForCreatedApp,
  waitForDeploy,
} from "./helpers";

// Instance admin page (`/apps/_control?t=admin`, with the telemetry tabs
// beside it): every
// verified for real — through the worker's own admin API, the runner API, or
// the affected account's own session — never just that the UI renders. One
// second account serves the whole file (tests are serial); the deployed sample
// app is created once and deleted through the Apps tab. Slugs are file-owned
// and dropped in afterAll, so parallel files are unaffected.
const SECOND_EMAIL = "admin-second@noite.local";
const SECOND_NAME = "Admin Second";
const REVOKED_EMAIL = "admin-revoked@noite.local";
const REVOKED_NAME = "Admin Revoked";
const PROBE_SLUG = "admin-probe";
const PROBE_NAME = "Admin Probe";
const DOOMED_SLUG = "admin-doomed";
const DOOMED_NAME = "Admin Doomed";
const OWN_SLUG = "admin-own";
const OWN_NAME = "Admin Own";

const control = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";
const CONTROL_STORAGE = "/storage/_control/d1%3Anoite-control";

interface EmailInviteView {
  createdByEmail: string;
  email: string;
  expiresAt: string;
  id: string;
  state: string;
  usedAt: string;
  usedByEmail: string;
}

interface SessionBody {
  session?: { impersonatedBy?: unknown };
  user?: { email?: string; id?: string };
}

interface RunnerAppView {
  desiredState: string;
  id: string;
  slug: string;
  status: string;
}

interface UsersBody {
  hasMore: boolean;
  users: { email: string; id: string }[];
}

let secondContext: BrowserContext | undefined;
let secondPage: Page | undefined;

const secondOrThrow = () => {
  if (!secondContext || !secondPage) {
    throw new Error("the second account was not registered");
  }

  return { context: secondContext, page: secondPage };
};

const adminListEmailInvites = async (
  request: APIRequestContext
): Promise<EmailInviteView[]> => {
  const res = await request.post("/api/admin/adminListEmailInvites", {
    data: {},
  });

  expect(res.ok()).toBe(true);

  // SAFETY: adminListEmailInvites answers the EmailInviteView array directly (apiActionNoInput serializes the return value as JSON).
  return (await res.json()) as EmailInviteView[];
};

type AdminActionInput =
  | { email: string }
  | { enabled: boolean }
  | { page: number; query: string }
  | { role: string; userId: string };

const adminPostBody = async (
  response: Promise<APIResponse>
): Promise<{ body: { errors?: { form?: string } }; status: number }> => {
  const res = await response;

  // SAFETY: failures answer { errors: { form } } (ActionFailure) or { error }; only the form shape is read.
  const body = (await res.json()) as { errors?: { form?: string } };

  return { body, status: res.status() };
};

const adminPost = (
  request: APIRequestContext,
  path: string,
  data: AdminActionInput
): Promise<{ body: { errors?: { form?: string } }; status: number }> =>
  adminPostBody(request.post(path, { data }));

/** Actions taking a bare id: the string rides JSON-encoded, or the action
 * reads it as invalid JSON (400) instead of decoding it through its schema. */
const adminPostId = (
  request: APIRequestContext,
  path: string,
  id: string
): Promise<{ body: { errors?: { form?: string } }; status: number }> =>
  adminPostBody(request.post(path, { data: JSON.stringify(id) }));

/** An account's row in the Users card. The "Invite by email" card above it
 * lists the same addresses (an invite and the account it admitted), so the
 * row is scoped to its own card. */
const userRow = (page: Page, email: string) =>
  page
    .getByRole("list", { exact: true, name: "Users" })
    .locator("li.list-row", { hasText: email });

const appRow = (page: Page, slug: string) =>
  page.locator("li.list-row", { hasText: slug });

/** An app card on the main /apps list (the sidebar repeats every app name in
 * plain `li`s, so the `.list-row` scope is what picks the main card). */
const appCard = (page: Page, name: string) =>
  page.locator("li.list-row", { hasText: name });

const confirmInDialog = async (page: Page, label: string): Promise<void> => {
  await page
    .getByRole("alertdialog")
    .getByRole("button", { exact: true, name: label })
    .click();
};

const usersSearch = (email: string): string =>
  `/apps/_control?t=admin&uq=${encodeURIComponent(email)}`;

const sessionOf = async (request: APIRequestContext): Promise<SessionBody> => {
  const res = await request.get("/api/auth/get-session");

  // SAFETY: better-auth get-session answers { user, session } when signed in and null when not; only email/id/impersonatedBy are read.
  const body = (await res.json()) as SessionBody | null;

  return body ?? {};
};

test.afterAll(async ({ request }) => {
  for (const slug of [PROBE_SLUG, DOOMED_SLUG, OWN_SLUG]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

test("email invites mint, revoke, and gate registration", async ({
  browser,
  page,
  request,
}) => {
  // One single-use invite per address, minted through the admin API. Each
  // invite is bound to its own address, so parallel workers minting theirs
  // never collide and no lock is needed.
  const revokedLink = await createEmailInviteLink(request, REVOKED_EMAIL);
  const liveLink = await createEmailInviteLink(request, SECOND_EMAIL);
  const revokedToken = inviteTokenOf(revokedLink);
  const liveToken = inviteTokenOf(liveLink);

  await page.goto("/apps/_control?t=admin");

  const invites = page.getByRole("list", {
    exact: true,
    name: "Invite by email",
  });

  const revokedRow = invites.locator("li.list-row", { hasText: REVOKED_EMAIL });
  // Badges match exactly: the address itself contains "revoked".
  await expect(
    revokedRow.getByText("available", { exact: true })
  ).toBeVisible();
  const liveRow = invites.locator("li.list-row", { hasText: SECOND_EMAIL });
  await expect(liveRow.getByText("available", { exact: true })).toBeVisible();

  await revokedRow.getByRole("button", { name: "Revoke" }).click();
  await expect(revokedRow.getByText("revoked", { exact: true })).toBeVisible();

  // Server-side proof of the revoke behind the badge.
  await expect(async () => {
    const current = await adminListEmailInvites(request);
    expect(current.find((inv) => inv.email === REVOKED_EMAIL)?.state).toBe(
      "revoked"
    );
  }).toPass({ timeout: 30_000 });

  // The revoked token is refused at the real gate: registration itself.
  const attemptContext = await browser.newContext({
    baseURL: control,
    storageState: { cookies: [], origins: [] },
  });

  try {
    const attempt = await attemptContext.newPage();
    await addVirtualAuthenticator(attempt);
    await attempt.goto(`/login?invite=${revokedToken}`);
    await attempt.getByRole("tab", { name: "Create account" }).click();
    await attempt.locator("#register-name").fill(REVOKED_NAME);
    await attempt.locator("#register-email").fill(REVOKED_EMAIL);
    await attempt.getByRole("button", { name: "Create passkey" }).click();
    await expect(
      attempt.getByText(
        "That invitation was revoked. Ask your admin for a new link."
      )
    ).toBeVisible();
    const refused = await sessionOf(attempt.request);
    expect(refused.user ?? null).toBeNull();
  } finally {
    await attemptContext.close();
  }

  // The live token still registers an account: this file's second account
  // is that proof, through the invite link itself.
  const second = await registerInviteeAccount(
    browser,
    liveToken,
    SECOND_EMAIL,
    SECOND_NAME
  );

  secondContext = second.context;
  secondPage = second.page;
  const registered = await sessionOf(second.page.request);
  expect(registered.user?.email).toBe(SECOND_EMAIL);

  // Server-side proof: the invite reads used by the new address.
  await expect(async () => {
    const current = await adminListEmailInvites(request);
    expect(current.find((inv) => inv.email === SECOND_EMAIL)?.usedByEmail).toBe(
      SECOND_EMAIL
    );
  }).toPass({ timeout: 30_000 });
});

test("the Admin tab finds the second account and refuses it admin surfaces", async ({
  page,
}) => {
  const { page: second } = secondOrThrow();

  await page.goto("/apps/_control?t=admin");
  await expect(page.locator("#admin-user-search")).toBeVisible();
  await page.locator("#admin-user-search").fill(SECOND_EMAIL);
  await page
    .getByRole("list", { name: "Users" })
    .getByRole("button", { name: "Search" })
    .click();
  const row = userRow(page, SECOND_EMAIL);
  await expect(row).toBeVisible();
  await expect(row.getByText(`${SECOND_EMAIL} · user`)).toBeVisible();

  // A non-admin is redirected to their own `/account` page whatever `?t=`
  // says: no Users section, no instance switches — and the admin APIs behind
  // those sections refuse the same session.
  await second.goto("/apps/_control?t=admin");
  await expect(second).toHaveURL(/\/account$/u);
  await expect(second.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(second.locator("#admin-user-search")).toHaveCount(0);

  const denied = await adminPost(second.request, "/api/admin/listUsers", {
    page: 0,
    query: "",
  });

  expect(denied.status).toBe(422);
  expect(denied.body.errors?.form).toContain("Admin only");

  // A legacy admin `?t=` redirects the same way, and so does the action
  // behind the instance switches.
  await second.goto("/apps/_control?t=settings");
  await expect(second).toHaveURL(/\/account$/u);
  await expect(second.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(
    second.getByRole("heading", { name: "Instance settings" })
  ).toHaveCount(0);

  const deniedTelemetry = await adminPost(
    second.request,
    "/api/telemetry/setTelemetry",
    { enabled: false }
  );

  expect(deniedTelemetry.status).toBe(422);
  expect(deniedTelemetry.body.errors?.form).toContain("Instance admins only");
});

test("make admin hands the second account a working admin gate", async ({
  page,
}) => {
  const { page: second } = secondOrThrow();

  await page.goto(usersSearch(SECOND_EMAIL));
  const row = userRow(page, SECOND_EMAIL);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Make admin" }).click();
  await confirmInDialog(page, "Make admin");
  await expect(row.getByText(`${SECOND_EMAIL} · admin`)).toBeVisible();

  await expect(async () => {
    const res = await second.request.post("/api/admin/listUsers", {
      data: { page: 0, query: "" },
    });

    expect(res.status()).toBe(200);

    // SAFETY: listUsers answers { users, hasMore }; only the user emails are read.
    const body = (await res.json()) as UsersBody;
    expect(body.users.map((user) => user.email)).toContain(SECOND_EMAIL);
  }).toPass({ timeout: 30_000 });

  await second.goto("/apps/_control?t=admin");
  await second.reload();
  await expect(second.locator("#admin-user-search")).toBeVisible();

  // The instance switches open for a real admin too.
  await second.goto("/apps/_control?t=admin");
  await expect(
    second.getByRole("heading", { name: "Instance settings" })
  ).toBeVisible();
});

test("the Admin tab stops and starts another account's app", async ({
  page,
  request,
}) => {
  const { page: second } = secondOrThrow();

  const { apiKey, appId } = await createAppWithKey(second, request, {
    name: PROBE_NAME,
    slug: PROBE_SLUG,
  });

  const sha = pushAppDir(
    apiKey,
    new URL("../test", import.meta.url),
    PROBE_SLUG
  );

  const deploy = await waitForDeploy(request, appId, 8 * 60_000, sha);
  expect(deploy.status).toBe("success");
  const port = await appListenPort(request, appId);
  const served = await readSampleApp(request, port);
  expect(Number.isInteger(served.n)).toBe(true);

  await page.goto(
    `/apps/_control?t=admin&aq=${encodeURIComponent(PROBE_SLUG)}`
  );
  const row = appRow(page, PROBE_SLUG);
  await expect(row).toBeVisible();
  await expect(row.getByText(SECOND_EMAIL)).toBeVisible();

  await row.getByRole("button", { name: "Stop" }).click();
  await expect(async () => {
    const app = await runnerApi<RunnerAppView>(request, `/v1/apps/${appId}`);
    expect(app.desiredState).toBe("stopped");
    expect(app.status).toBe("stopped");
  }).toPass({ timeout: 120_000 });
  await expect(async () => {
    let up = true;

    try {
      await readSampleApp(request, port);
    } catch {
      up = false;
    }

    expect(up).toBe(false);
  }).toPass({ timeout: 120_000 });

  await row.getByRole("button", { name: "Start" }).click();
  await expect(row.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(async () => {
    const live = await readSampleApp(request, port);
    expect(Number.isInteger(live.n)).toBe(true);
  }).toPass({ timeout: 120_000 });
});

test("impersonation swaps the session, refuses admin surfaces, and returns cleanly", async ({
  browser,
  page,
}) => {
  // The admin owns a bare app the second account must never see: while
  // impersonating, its absence proves the session swap.
  await page.goto("/apps/new");
  await page.locator("#create-name").fill(OWN_NAME);
  await page.locator("#create-slug").fill(OWN_SLUG);
  await page.getByRole("button", { name: "Create app" }).click();
  await waitForCreatedApp(page);

  await page.goto(usersSearch(SECOND_EMAIL));
  const row = userRow(page, SECOND_EMAIL);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Impersonate" }).click();
  await expect(page.getByText(`Impersonating ${SECOND_EMAIL}`)).toBeVisible();
  await page.reload();
  await expect(page.getByText(`Impersonating ${SECOND_EMAIL}`)).toBeVisible();

  // The browser now acts as the second account: its own app is here, the
  // admin's is not, and the session itself says so.
  await page.goto("/apps");
  await expect(appCard(page, PROBE_NAME)).toBeVisible();
  await expect(appCard(page, OWN_NAME)).toBeHidden();
  const swapped = await sessionOf(page.request);
  expect(swapped.user?.email).toBe(SECOND_EMAIL);
  expect(swapped.session?.impersonatedBy ?? null).not.toBeNull();

  // Admin-only surfaces refuse the impersonated session even though the
  // impersonated account is an admin.
  await page.goto("/apps/_control?t=admin");
  await expect(page.getByText("App not found.")).toBeVisible();

  const denied = await adminPost(page.request, "/api/admin/listUsers", {
    page: 0,
    query: "",
  });

  expect(denied.status).toBe(422);
  expect(denied.body.errors?.form).toContain("Admin only");
  await page.goto(CONTROL_STORAGE);
  await expect(
    page.getByText("The control database is not available while impersonating")
  ).toBeVisible();

  await page.goto("/apps");
  await page.getByRole("button", { name: "Return to admin" }).click();
  await expect(page.locator("#admin-user-search")).toBeVisible();
  await expect(page.getByText(`Impersonating ${SECOND_EMAIL}`)).toBeHidden();

  // Back to the admin session, with the admin's apps visible again.
  const restored = await sessionOf(page.request);
  expect(restored.user?.email).not.toBe(SECOND_EMAIL);
  expect(restored.session?.impersonatedBy ?? null).toBeNull();
  await page.goto("/apps");
  await expect(appCard(page, OWN_NAME)).toBeVisible();

  // The shared bootstrap session file still authenticates: other files'
  // storageState was never broken by the round trip.
  const fresh = await browser.newContext({
    baseURL: control,
    storageState: process.env.E2E_AUTH_DIR
      ? `${process.env.E2E_AUTH_DIR}/user.json`
      : "e2e/.auth/user.json",
  });

  try {
    const bootstrap = await sessionOf(fresh.request);
    expect(bootstrap.user?.email).not.toBe(SECOND_EMAIL);
    expect(bootstrap.user?.email).not.toBeNull();
  } finally {
    await fresh.close();
  }
});

test("the Admin tab deletes another account's app", async ({
  page,
  request,
}) => {
  const { page: second } = secondOrThrow();

  await page.goto(
    `/apps/_control?t=admin&aq=${encodeURIComponent(PROBE_SLUG)}`
  );
  const row = appRow(page, PROBE_SLUG);
  await expect(row).toBeVisible();

  // Wait for the action's answer, not the runner listing: the runner hides
  // an app the moment its delete starts, and the action drops the grants
  // (including PROBE's collaborator row) only after the runner answered.
  // The next test counts those grants, so leaving before the answer here
  // leaves a stale row behind.
  const deleted = page.waitForResponse((response) =>
    response.url().endsWith("/api/admin/adminDeleteApp")
  );

  await row.getByRole("button", { name: "Delete" }).click();
  await confirmInDialog(page, "Delete");
  await expect(page.getByText("No apps match that search.")).toBeVisible();

  const answer = await deleted;
  expect(answer.ok()).toBe(true);
  await expect(async () => {
    expect(await findAppId(request, PROBE_SLUG)).toBeNull();
  }).toPass({ timeout: 60_000 });

  await second.goto("/apps");
  await expect(second.getByText("No apps yet.")).toBeVisible();
});

test("remove admin takes the gate back", async ({ page }) => {
  const { page: second } = secondOrThrow();

  await page.goto(usersSearch(SECOND_EMAIL));
  const row = userRow(page, SECOND_EMAIL);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Remove admin" }).click();
  await confirmInDialog(page, "Remove admin");
  await expect(row.getByText(`${SECOND_EMAIL} · user`)).toBeVisible();

  await expect(async () => {
    const denied = await adminPost(second.request, "/api/admin/listUsers", {
      page: 0,
      query: "",
    });

    expect(denied.status).toBe(422);
  }).toPass({ timeout: 30_000 });
  // Demoted back to a plain account: `/apps/_control` redirects to
  // `/account`, which is personal settings only.
  await second.goto("/apps/_control?t=admin");
  await second.reload();
  await expect(second).toHaveURL(/\/account$/u);
  await expect(second.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(second.locator("#admin-user-search")).toHaveCount(0);
});

test("ban freezes the session and sign-in; unban restores both", async ({
  page,
}) => {
  const { page: second } = secondOrThrow();

  await page.goto(usersSearch(SECOND_EMAIL));
  const row = userRow(page, SECOND_EMAIL);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Ban" }).click();
  await expect(row.getByText("banned", { exact: true })).toBeVisible();

  // The existing session stops working: the worker no longer sees a user,
  // and the dashboard bounces to the login page.
  await expect(async () => {
    const banned = await sessionOf(second.request);
    expect(banned.user ?? null).toBeNull();
  }).toPass({ timeout: 30_000 });
  await second.goto("/apps");
  await expect(second).toHaveURL(/\/login/u);

  // A fresh passkey sign-in is refused while banned: better-auth answers
  // the ban with its own message (not ours — match the stable substring).
  await second.goto("/login");
  await second.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(second.getByText(/banned from this application/u)).toBeVisible({
    timeout: 30_000,
  });
  await expect(second).toHaveURL(/\/login/u);
  const stillBanned = await sessionOf(second.request);
  expect(stillBanned.user ?? null).toBeNull();

  await row.getByRole("button", { name: "Unban" }).click();
  await expect(row.getByText("banned", { exact: true })).toBeHidden();

  await second.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(second).toHaveURL(/\/apps/u, { timeout: 30_000 });
  const back = await sessionOf(second.request);
  expect(back.user?.email).toBe(SECOND_EMAIL);
});

test("delete refuses the sole admin of an app, then removes the freed account", async ({
  page,
  request,
}) => {
  const { context, page: second } = secondOrThrow();

  await second.goto("/apps/new");
  await second.locator("#create-name").fill(DOOMED_NAME);
  await second.locator("#create-slug").fill(DOOMED_SLUG);
  await second.getByRole("button", { name: "Create app" }).click();
  await waitForCreatedApp(second);
  expect(await findAppId(request, DOOMED_SLUG)).not.toBeNull();

  // Deleting the only admin of an app is refused: the account, its row and
  // its session survive.
  await page.goto(usersSearch(SECOND_EMAIL));
  const row = userRow(page, SECOND_EMAIL);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  await confirmInDialog(page, "Delete");
  await expect(page.getByText(/only admin of 1 app/u)).toBeVisible();
  await expect(userRow(page, SECOND_EMAIL)).toBeVisible();
  const spared = await sessionOf(second.request);
  expect(spared.user?.email).toBe(SECOND_EMAIL);

  // The admin deletes the app first (which drops its grants), then the user.
  await page.goto(
    `/apps/_control?t=admin&aq=${encodeURIComponent(DOOMED_SLUG)}`
  );
  const doomed = appRow(page, DOOMED_SLUG);
  await expect(doomed).toBeVisible();

  // Wait for the action's answer, not the runner listing: the runner hides
  // an app the moment its delete starts, and the action drops the grants
  // only after the runner answered.
  const deleted = page.waitForResponse((response) =>
    response.url().endsWith("/api/admin/adminDeleteApp")
  );

  await doomed.getByRole("button", { name: "Delete" }).click();
  await confirmInDialog(page, "Delete");

  const answer = await deleted;
  expect(answer.ok()).toBe(true);
  await expect(async () => {
    expect(await findAppId(request, DOOMED_SLUG)).toBeNull();
  }).toPass({ timeout: 60_000 });

  await page.goto(usersSearch(SECOND_EMAIL));
  const freed = userRow(page, SECOND_EMAIL);
  await expect(freed).toBeVisible();
  await freed.getByRole("button", { name: "Delete" }).click();
  await confirmInDialog(page, "Delete");
  await expect(page.getByText("No users match that search.")).toBeVisible();

  // The session is dead and the account is gone from the list.
  await expect(async () => {
    const gone = await sessionOf(second.request);
    expect(gone.user ?? null).toBeNull();
  }).toPass({ timeout: 30_000 });
  await second.goto("/apps");
  await expect(second).toHaveURL(/\/login/u);

  await context.close();
  secondContext = undefined;
  secondPage = undefined;
});

test("self-guards and invite validation hold at the real gate", async ({
  browser,
  page,
  request,
}) => {
  const self = await sessionOf(request);
  const selfId = self.user?.id ?? "";
  expect(selfId).not.toBe("");

  const removeSelf = await adminPostId(
    request,
    "/api/admin/deleteUser",
    selfId
  );

  expect(removeSelf.status).toBe(422);
  expect(removeSelf.body.errors?.form).toContain(
    "Cannot delete your own account"
  );

  const banSelf = await adminPostId(request, "/api/admin/banUser", selfId);
  expect(banSelf.status).toBe(422);
  expect(banSelf.body.errors?.form).toContain("Cannot ban your own account");

  const demoteSelf = await adminPost(request, "/api/admin/setUserRole", {
    role: "user",
    userId: selfId,
  });

  expect(demoteSelf.status).toBe(422);
  expect(demoteSelf.body.errors?.form).toContain("Cannot change your own role");

  // A blank address is refused before a row lands.
  const blank = await adminPost(request, "/api/admin/adminCreateEmailInvite", {
    email: "   ",
  });

  expect(blank.status).toBe(422);
  expect(blank.body.errors?.form).toContain("An email address is required");

  // The admin's own row offers no actions: this is the UI side of the
  // self-guards above.
  await page.goto(usersSearch(self.user?.email ?? ""));
  const own = userRow(page, self.user?.email ?? "");
  await expect(own).toBeVisible();
  await expect(own.getByText("you")).toBeVisible();
  await expect(own.getByRole("button")).toHaveCount(0);

  // Signed out, the admin APIs refuse instead of leaking: a bare
  // newContext() would inherit the project's storageState, so the empty
  // store is passed explicitly.
  const anon = await browser.newContext({
    baseURL: control,
    storageState: { cookies: [], origins: [] },
  });

  try {
    const response = await anon.request.post(
      "/api/admin/adminListEmailInvites",
      {
        data: {},
      }
    );

    expect(response.status()).toBe(422);

    // SAFETY: the refusal answers { errors: { form } }; only that message is read.
    const refusal = (await response.json()) as { errors?: { form?: string } };
    expect(refusal.errors?.form).toContain("Admin only");
  } finally {
    await anon.close();
  }
});
