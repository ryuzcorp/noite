import { expect, test } from "@playwright/test";

// Invite-only registration, pinned at the policy the signup panel reads.
//
// The first account (auth.setup) registered with no code and bootstrapped the
// instance; from then on `/api/invite/status` must tell every client that a
// code is required and how many each new account receives.
//
// Not covered here, both blocked by the known issue in SPEC.md: redeeming a
// code (validate → claim → mint is several D1 round trips inside one action,
// and the control node's D1 stalls under that) and reading an account's own
// codes (the profile panel, an action-driven surface).
test("the signup policy flips to invite-only after the first account", async ({
  request,
}) => {
  const res = await request.get("http://localhost:8090/api/invite/status");
  expect(res.ok()).toBe(true);
  // SAFETY: the route answers exactly this shape (see handleInviteStatus).
  const policy = (await res.json()) as {
    firstRun: boolean;
    invitesPerUser: number;
    requiresInvite: boolean;
  };
  // The bootstrap account exists, so registration is no longer open.
  expect(policy.firstRun).toBe(false);
  expect(policy.requiresInvite).toBe(true);
  // Each admitted account can pass the flow on.
  expect(policy.invitesPerUser).toBe(2);
  // The payload carries no account data.
  expect(Object.keys(policy).toSorted()).toEqual([
    "firstRun",
    "invitesPerUser",
    "requiresInvite",
  ]);
});
