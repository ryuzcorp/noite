/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Schema from "effect/Schema";
import { sql } from "void/db";

import { userTable } from "../../db/schema";
import { authFromEnv, failUnknown, UnauthorizedError } from "../auth";
import { listAppsForCollaborator } from "../collaborators";
import { getDb, withDb } from "../db";
import { EXPIRY_PRESETS } from "../key-principal";
import { parseAppRole, roleAtLeast } from "../roles";
import { apiAction, apiActionNoInput, fail } from "./api";
import { keyOwnerActive } from "./api-keys.server";
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

  await withDb(() =>
    getDb()
      .update(userTable)
      .set({ onboardedAt: new Date().toISOString() })
      .where(
        sql`${userTable.id} = ${user.id} AND ${userTable.onboardedAt} IS NULL`
      )
  );

  return { ok: true };
});

/** The app ids a new key may be limited to: deduplicated, and each one must be
 * an app this account can already see. Validating here is convenience — the
 * role gate re-checks per request — but a typo would otherwise mint a key that
 * silently reaches nothing. `null` stays account-wide. */
const checkedApps = async (
  userId: string,
  wanted: readonly string[] | null
): Promise<string[] | null> => {
  if (wanted === null) {
    return null;
  }

  const ids = [...new Set(wanted.map((id) => id.trim()).filter(Boolean))];

  if (ids.length === 0) {
    fail("Pick at least one app, or leave the key account-wide");
  }

  const apps = await listAppsForCollaborator(userId);
  const visible = new Set(apps.map((app) => app.id));

  if (ids.some((id) => !visible.has(id))) {
    fail("Every app on a key must be one you can access");
  }

  return ids;
};
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

const CreateApiKey = Schema.Struct({
  /** The apps the key acts on; `null`/absent is account-wide. */
  appIds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  appManagement: Schema.Boolean,
  events: Schema.Boolean,
  /** One of `EXPIRY_PRESETS`' durations, or `null` for "never". */
  expirySeconds: Schema.optional(Schema.NullOr(Schema.Number)),
  name: Schema.String,
  /** The highest app role the key may reach (`view`, `push` or `admin`). */
  roleCeiling: Schema.optional(Schema.String),
});

/** The expiry presets the action accepts, so a client cannot mint a key that
 * outlives the form's own choices. */
const ACCEPTED_EXPIRY = new Set<number>(
  Object.values(EXPIRY_PRESETS).filter((seconds) => seconds !== null)
);

/** Profile API key with machine scopes, an optional app set, a role ceiling
 * and an expiry. Permissions are server-only in better-auth, so creation goes
 * through this action (the client SDK cannot set them); the scope rides in
 * `metadata` (lib/key-principal). Returns the raw key once — the UI shows it
 * once, like the client flow did. */
export const createApiKey = apiAction(
  CreateApiKey,
  async (
    {
      appIds: wantedApps,
      appManagement,
      events,
      expirySeconds,
      name,
      roleCeiling,
    },
    { env, request }
  ) => {
    const user = await sessionUser(request, env);
    const label = name.trim();

    // A banned owner must not mint new machine credentials: the ban's key
    // revocation only covers the keys that existed then (the plugin's own
    // `/api-key/create` enforces the same rule for direct calls).
    if (!(await keyOwnerActive(user.id))) {
      fail("This account is banned");
    }

    if (!label) {
      fail("Name is required");
    }

    if (!(appManagement || events)) {
      fail("Select at least one scope");
    }

    const ceiling =
      parseAppRole(roleCeiling ?? "admin") ??
      fail("Role ceiling must be view, push or admin");

    // An ingest key acts with the push role; a ceiling below it could never
    // ingest, so refuse the combination instead of minting a dead credential.
    if (events && !roleAtLeast(ceiling, "push")) {
      fail("Event ingest needs the push role or a higher ceiling");
    }

    const expiry = expirySeconds ?? null;

    if (expiry !== null && !ACCEPTED_EXPIRY.has(expiry)) {
      fail("Expiry must be one of the offered presets");
    }

    const appIds = await checkedApps(user.id, wantedApps ?? null);
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
      body: {
        expiresIn: expiry ?? undefined,
        metadata: { appIds, roleCeiling: ceiling },
        name: label,
        permissions,
        userId: user.id,
      },
    });

    const key = created?.key;

    if (!key) {
      fail("Failed to create API key");
    }

    return { key };
  }
);
