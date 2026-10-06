/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { action, fail, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import {
  acceptPendingInvite,
  countAdmins,
  declinePendingInvite,
  grantCollaborator,
  listCollaboratorRows,
  listInvitesForEmail,
  listPendingInvites,
  normalizeEmail,
  requireAppRole,
  revokePendingInvite,
  upsertPendingInvite,
} from "../collaborators";
import { orm, withDb } from "../db";
import { parseAppRole } from "../roles";
import { AuthError, sessionUser } from "./session.server";

const AppId = Schema.String;

const InviteCollaborator = Schema.Struct({
  appId: Schema.String,
  email: Schema.String,
  role: Schema.String,
});

const UpdateCollaborator = Schema.Struct({
  appId: Schema.String,
  role: Schema.String,
  userId: Schema.String,
});

const RemoveCollaborator = Schema.Struct({
  appId: Schema.String,
  userId: Schema.String,
});

export const listCollaborators = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "view");
    return listCollaboratorRows(appId);
  }),
  { error: AuthError }
);

/** Invite an email to an app. Never reveals whether the address has an
 * account: an existing collaborator's role is updated in place (they are
 * already visible in the list), anyone else gets a pending invitation they
 * accept after signing in with that address. */
export const inviteCollaborator = action(
  withSchema(InviteCollaborator, async ({ appId, email, role }) => {
    const user = await sessionUser();
    const { app } = await requireAppRole(appId, user.id, "admin");
    const nextRole = parseAppRole(role.trim().toLowerCase());
    if (nextRole === null) {
      return fail("role must be view, push, or admin");
    }
    const normalized = normalizeEmail(email);
    if (!normalized.includes("@")) {
      return fail("Valid email required");
    }
    try {
      const members = await listCollaboratorRows(appId);
      const member = members.find(
        (row) => normalizeEmail(row.email) === normalized
      );
      if (member) {
        await withDb(grantCollaborator(appId, member.userId, nextRole));
        return { ok: true as const, status: "updated" as const };
      }
      await withDb(
        upsertPendingInvite({
          appId,
          appName: app.name,
          email: normalized,
          invitedBy: user.id,
          role: nextRole,
        })
      );
      return { ok: true as const, status: "invited" as const };
    } catch (error) {
      return failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Invitations waiting on an app (admin only: they carry email addresses). */
export const listPendingInvitations = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    return listPendingInvites(appId);
  }),
  { error: AuthError }
);

export const revokeInvitation = action(
  withSchema(
    Schema.Struct({ appId: Schema.String, inviteId: Schema.String }),
    async ({ appId, inviteId }) => {
      const user = await sessionUser();
      await requireAppRole(appId, user.id, "admin");
      await withDb(revokePendingInvite(appId, inviteId));
      return { ok: true as const };
    }
  ),
  { error: AuthError }
);

/** Invitations addressed to the signed-in account's email. */
export const myCollaboratorInvitations = action(
  async () => {
    const user = await sessionUser();
    try {
      return await listInvitesForEmail(user.email);
    } catch (error) {
      return failUnknown(error);
    }
  },
  { error: AuthError }
);

/** Accept an invitation: the grant is created for the session account only
 * when the invitation is addressed to its email. */
export const acceptInvitation = action(
  withSchema(Schema.String, async (inviteId) => {
    const user = await sessionUser();
    const accepted = await acceptPendingInvite(inviteId, user.email, user.id);
    if (!accepted) {
      return fail("Invitation not found");
    }
    return { appId: accepted.appId, ok: true as const };
  }),
  { error: AuthError }
);

export const declineInvitation = action(
  withSchema(Schema.String, async (inviteId) => {
    const user = await sessionUser();
    await withDb(declinePendingInvite(inviteId, user.email));
    return { ok: true as const };
  }),
  { error: AuthError }
);

export const updateCollaboratorRole = action(
  withSchema(UpdateCollaborator, async ({ appId, userId, role }) => {
    const actor = await sessionUser();
    await requireAppRole(appId, actor.id, "admin");
    const nextRole = parseAppRole(role.trim().toLowerCase());
    if (nextRole === null) {
      return fail("role must be view, push, or admin");
    }
    const err = await withDb(
      Effect.gen(function* run() {
        const membership = yield* orm.app_collaborator.findFirst({
          where: { appId, userId },
        });
        if (!membership) {
          return "Collaborator not found";
        }
        const current = parseAppRole(membership.role);
        if (current === "admin" && nextRole !== "admin") {
          const admins = yield* countAdmins(appId);
          if (admins <= 1) {
            return "Cannot demote the last admin";
          }
        }
        yield* orm.app_collaborator.update({
          data: { role: nextRole },
          where: { id: membership.id },
        });
        return "";
      })
    );
    if (err) {
      return fail(err);
    }
    return { ok: true as const };
  }),
  { error: AuthError }
);

export const removeCollaborator = action(
  withSchema(RemoveCollaborator, async ({ appId, userId }) => {
    const actor = await sessionUser();
    await requireAppRole(appId, actor.id, "admin");
    const err = await withDb(
      Effect.gen(function* run() {
        const membership = yield* orm.app_collaborator.findFirst({
          where: { appId, userId },
        });
        if (!membership) {
          return "";
        }
        if (parseAppRole(membership.role) === "admin") {
          const admins = yield* countAdmins(appId);
          if (admins <= 1) {
            return "Cannot remove the last admin";
          }
        }
        yield* orm.app_collaborator.delete({ where: { id: membership.id } });
        return "";
      })
    );
    if (err) {
      return fail(err);
    }
    return { ok: true as const };
  }),
  { error: AuthError }
);
