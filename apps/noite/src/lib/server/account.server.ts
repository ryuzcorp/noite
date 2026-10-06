/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import { action, fail, useEnv, useRequest, withSchema } from "oxidejs";

import { authFromEnv, failUnknown, UnauthorizedError } from "../auth";
import { withDb } from "../db";
import { listUnusedInvitesFor } from "./invites.server";
import { AuthError, requestOrigin, sessionUser } from "./session.server";

/** Mark the signed-in account as having completed the first-run onboarding.
 * Idempotent: the `onboardedAt IS NULL` guard means a second call (a
 * double-click, or the close handler racing Finish) writes nothing. Refused
 * on an impersonated session — an admin touring as another user must not
 * consume that user's one-time tour. */
export const completeOnboarding = action(
  async () => {
    const user = await sessionUser();
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
  },
  { error: AuthError }
);
const CreateApiKey = Schema.Struct({
  appManagement: Schema.Boolean,
  events: Schema.Boolean,
  name: Schema.String,
});

/** Profile API key with machine scopes. Permissions are server-only in
 * better-auth, so creation goes through this action (the client SDK
 * cannot set them). Returns the raw key once — the UI shows it once,
 * like the client flow did. */
export const createApiKey = action(
  withSchema(CreateApiKey, async ({ appManagement, events, name }) => {
    const user = await sessionUser();
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
    const request = useRequest();
    const env = useEnv<KitEnv>() ?? process.env;
    const origin = requestOrigin(request);
    if (!origin) {
      throw new UnauthorizedError({ message: "Sign in required" });
    }
    const auth = authFromEnv(
      // SAFETY: the ALS env (or process.env fallback) provides the same KitEnv control keys used by every action.
      env as KitEnv,
      origin
    );
    const created = await auth.api.createApiKey({
      body: { name: label, permissions, userId: user.id },
    });
    const key = created?.key;
    if (!key) {
      fail("Failed to create API key");
    }
    return { key };
  }),
  { error: AuthError }
);
// ---- Invitations a member can hand out ----

/** The signed-in account's unused codes (see `INVITES_PER_USER`). */
export const myInviteCodes = action(
  async () => {
    const user = await sessionUser();
    try {
      return await listUnusedInvitesFor(user.id);
    } catch (error) {
      failUnknown(error);
    }
  },
  { error: AuthError }
);
