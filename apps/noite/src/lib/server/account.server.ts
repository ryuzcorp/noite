/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";

import { authFromEnv, failUnknown, UnauthorizedError } from "../auth";
import { withDb } from "../db";
import { apiAction, apiActionNoInput, fail } from "./api";
import { listUnusedInvitesFor } from "./invites.server";
import { requestOrigin, sessionUser } from "./session.server";

/** Mark the signed-in account as having completed the first-run onboarding.
 * Idempotent: the `onboardedAt IS NULL` guard means a second call (a
 * double-click, or the close handler racing Finish) writes nothing. Refused
 * on an impersonated session — an admin touring as another user must not
 * consume that user's one-time tour. */
export const completeOnboarding = apiActionNoInput(async ({ env, request }) => {
  const user = await sessionUser(request, env);
  if (user.impersonatedBy) {
    fail("Onboarding cannot be completed while impersonating");
  }
  await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        `UPDATE user SET onboardedAt = ? WHERE id = ? AND onboardedAt IS NULL`,
        [new Date().toISOString(), user.id]
      );
    })
  );
  return { ok: true };
});
const CreateApiKey = Schema.Struct({
  appManagement: Schema.Boolean,
  events: Schema.Boolean,
  name: Schema.String,
});

/** Profile API key with machine scopes. Permissions are server-only in
 * better-auth, so creation goes through this action (the client SDK
 * cannot set them). Returns the raw key once — the UI shows it once,
 * like the client flow did. */
export const createApiKey = apiAction(
  CreateApiKey,
  async ({ appManagement, events, name }, { env, request }) => {
    const user = await sessionUser(request, env);
    const label = name.trim();
    if (!label) {
      fail("Name is required");
    }
    if (!appManagement && !events) {
      fail("Select at least one scope");
    }
    const permissions: Record<string, string[]> = {};
    if (appManagement) {
      permissions.apps = ["manage"];
    }
    if (events) {
      permissions.events = ["push"];
    }
    const origin = requestOrigin(request);
    if (!origin) {
      throw new UnauthorizedError({ message: "Sign in required" });
    }
    const auth = authFromEnv(env, origin);
    const created = await auth.api.createApiKey({
      body: { name: label, permissions, userId: user.id },
    });
    const key = created?.key;
    if (!key) {
      fail("Failed to create API key");
    }
    return { key };
  }
);
// ---- Invitations a member can hand out ----

/** The signed-in account's unused codes (see `INVITES_PER_USER`). */
export const myInviteCodes = apiActionNoInput(async ({ env, request }) => {
  const user = await sessionUser(request, env);
  try {
    return await listUnusedInvitesFor(user.id);
  } catch (error) {
    failUnknown(error);
  }
});
