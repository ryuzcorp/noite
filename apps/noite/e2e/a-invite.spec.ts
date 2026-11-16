import { expect, test } from "@playwright/test";

import { registerInviteeAccount } from "./helpers";

// Instance invitations by email and the registration waitlist, pinned at the
// policy the signup panel reads.
//
// The first account (auth.setup) registered and bootstrapped the instance; from
// then on `/api/invite/status` tells every client that registration needs an
// invite link — or queues on the waitlist while it is enabled.
//
// Not covered here: redeeming a link (the admin spec registers its second
// account through one, for real) and reading the admin invite list (the Users
// tab paints it).
const control = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

test("the signup policy names the waitlist after the first account", async ({
  request,
}) => {
  const res = await request.get(`${control}/api/invite/status`);
  expect(res.ok()).toBe(true);

  // SAFETY: the route answers exactly this shape (see handleInviteStatus).
  const policy = (await res.json()) as {
    adminExists: boolean;
    firstRun: boolean;
    setupMode: string;
    waitlistEnabled: boolean;
  };

  // The bootstrap account exists, so registration is no longer open.
  expect(policy.firstRun).toBe(false);
  // The first account became the admin, so the first-admin gate is closed.
  expect(policy.adminExists).toBe(true);
  expect(policy.setupMode).toBe("off");
  // The waitlist ships off: uninvited registration is refused outright.
  expect(policy.waitlistEnabled).toBe(false);
  // The payload carries no account data and never the setup code.
  expect(Object.keys(policy).toSorted()).toEqual([
    "adminExists",
    "firstRun",
    "setupMode",
    "waitlistEnabled",
  ]);
});

test("an uninvited signup waits, an approval admits", async ({
  browser,
  request,
}) => {
  const enable = await request.post("/api/admin/setWaitlist", {
    data: { enabled: true },
  });

  expect(enable.ok()).toBe(true);

  const email = `waitlist-${Date.now()}@example.com`;

  const { context, page } = await registerInviteeAccount(
    browser,
    null,
    email,
    "Waitlist User"
  );

  try {
    // The account exists but holds no access: the app shell paints only the
    // waiting page.
    await expect(page.getByText("Waiting for approval")).toBeVisible();

    // The one JSON action a waiting account may call says pending…
    const status = await page.request.post(
      "/api/account/registrationStatus",
      {}
    );

    expect(status.ok()).toBe(true);
    expect(await status.json()).toEqual({ status: "pending" });

    // …and every other action refuses it instead of serving.
    const gated = await page.request.post(
      "/api/account/completeOnboarding",
      {}
    );

    expect(gated.status()).toBe(403);

    // The admin approves by id (the Users tab would do the same).
    const listed = await request.post("/api/admin/listUsers", {
      data: { page: 0, query: email },
    });

    expect(listed.ok()).toBe(true);

    // SAFETY: listUsers answers { hasMore, users }; only the new row's id is read.
    const { users } = (await listed.json()) as {
      users: { email: string; id: string }[];
    };

    const id = users.find((row) => row.email === email)?.id ?? "";
    expect(id).not.toBe("");

    const approve = await request.post("/api/admin/approveUser", {
      data: JSON.stringify(id),
    });

    expect(approve.ok()).toBe(true);

    // …and the user gets in on the next check: the waiting page paints the
    // app, starting with the onboarding tour.
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText("Waiting for approval")).toBeHidden({
      timeout: 30_000,
    });
    await expect(page.locator("#onboarding-next")).toBeVisible();
  } finally {
    await context.close();
    // The lane's other specs register invited-only: leave the switch as found.
    await request.post("/api/admin/setWaitlist", {
      data: { enabled: false },
    });
  }
});
