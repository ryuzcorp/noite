import * as Schema from "effect/Schema";
import { and, eq } from "void/db";

import { appCollaboratorTable } from "../../db/schema";
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
  removeGrant,
  requireAppRole,
  revokeMemberInvites,
  revokePendingInvite,
  upsertPendingInvite,
  writeGrant,
} from "../collaborators";
import { getDb, withDb } from "../db";
import { decideGrant, decideRemove } from "../membership";
import { parseAppRole } from "../roles";
import { apiAction, apiActionNoInput, fail } from "./api";
import { sessionUser } from "./session.server";

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

export const listCollaborators = apiAction(
  AppId,
  async (appId, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "view");

    return listCollaboratorRows(appId);
  }
);

/** Invite an email to an app. Never reveals whether the address has an
 * account: an existing collaborator's role is updated in place (they are
 * already visible in the list), anyone else gets a pending invitation they
 * accept after signing in with that address. */
export const inviteCollaborator = apiAction(
  InviteCollaborator,
  async ({ appId, email, role }, { env, request }) => {
    const user = await sessionUser(request, env);
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
        const write = await grantCollaborator(appId, member.userId, nextRole);

        if (write !== "applied") {
          return fail(
            write === "last-admin"
              ? "Cannot demote the last admin"
              : "That collaborator was removed meanwhile; reload and try again"
          );
        }

        return { ok: true as const, status: "updated" as const };
      }

      await upsertPendingInvite({
        appId,
        appName: app.name,
        email: normalized,
        invitedBy: user.id,
        role: nextRole,
      });

      return { ok: true as const, status: "invited" as const };
    } catch (error) {
      return failUnknown(error);
    }
  }
);

/** Invitations waiting on an app (admin only: they carry email addresses). */
export const listPendingInvitations = apiAction(
  AppId,
  async (appId, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");

    return listPendingInvites(appId);
  }
);

export const revokeInvitation = apiAction(
  Schema.Struct({ appId: Schema.String, inviteId: Schema.String }),
  async ({ appId, inviteId }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");
    await revokePendingInvite(appId, inviteId);

    return { ok: true as const };
  }
);

/** Invitations addressed to the signed-in account's email. */
export const myCollaboratorInvitations = apiActionNoInput(
  async ({ env, request }) => {
    const user = await sessionUser(request, env);

    try {
      return await listInvitesForEmail(user.email);
    } catch (error) {
      return failUnknown(error);
    }
  }
);

/** Accept an invitation: the grant is created for the session account only
 * when the invitation is addressed to its email. */
export const acceptInvitation = apiAction(
  Schema.String,
  async (inviteId, { env, request }) => {
    const user = await sessionUser(request, env);
    const accepted = await acceptPendingInvite(inviteId, user.email, user.id);

    if (accepted._tag === "NotFound") {
      return fail("Invitation not found");
    }

    if (accepted._tag === "Refused") {
      return fail(
        accepted.reason === "last-admin"
          ? "This app would be left without an admin — ask another admin to change the invitation first."
          : "This app's access changed while you accepted — ask for a new invitation."
      );
    }

    return { appId: accepted.appId, ok: true as const };
  }
);

export const declineInvitation = apiAction(
  Schema.String,
  async (inviteId, { env, request }) => {
    const user = await sessionUser(request, env);
    await declinePendingInvite(inviteId, user.email);

    return { ok: true as const };
  }
);

export const updateCollaboratorRole = apiAction(
  UpdateCollaborator,
  async ({ appId, userId, role }, { env, request }) => {
    const actor = await sessionUser(request, env);
    await requireAppRole(appId, actor.id, "admin");
    const nextRole = parseAppRole(role.trim().toLowerCase());

    if (nextRole === null) {
      return fail("role must be view, push, or admin");
    }

    // One conditional write carries the last-admin invariant; the account
    // must hold a grant already (grants are created by invitation).
    const current = await withDb(() =>
      getDb()
        .select({ role: appCollaboratorTable.role })
        .from(appCollaboratorTable)
        .where(
          and(
            eq(appCollaboratorTable.appId, appId),
            eq(appCollaboratorTable.userId, userId)
          )
        )
        .limit(1)
    );

    const [membership] = current;

    if (!membership) {
      return fail("Collaborator not found");
    }

    const decision = decideGrant({
      adminCount: await countAdmins(appId),
      current: parseAppRole(membership.role),
      next: nextRole,
    });

    if (decision._tag === "Refused") {
      return fail("Cannot demote the last admin");
    }

    const write = await writeGrant(appId, userId, nextRole);

    if (write !== "applied") {
      return fail(
        write === "last-admin"
          ? "Cannot demote the last admin"
          : "That collaborator was removed meanwhile; reload and try again"
      );
    }

    return { ok: true as const };
  }
);

export const removeCollaborator = apiAction(
  RemoveCollaborator,
  async ({ appId, userId }, { env, request }) => {
    const actor = await sessionUser(request, env);
    await requireAppRole(appId, actor.id, "admin");

    const rows = await withDb(() =>
      getDb()
        .select({ role: appCollaboratorTable.role })
        .from(appCollaboratorTable)
        .where(
          and(
            eq(appCollaboratorTable.appId, appId),
            eq(appCollaboratorTable.userId, userId)
          )
        )
        .limit(1)
    );

    const [membership] = rows;

    if (!membership) {
      return { ok: true as const };
    }

    const decision = decideRemove({
      adminCount: await countAdmins(appId),
      current: parseAppRole(membership.role),
    });

    if (decision._tag === "Refused") {
      return fail("Cannot remove the last admin");
    }

    const write = await removeGrant(appId, userId);

    if (write === "last-admin") {
      return fail("Cannot remove the last admin");
    }

    // An invitation for a removed member would re-grant on accept, so it goes
    // with the grant.
    await revokeMemberInvites(appId, userId);

    return { ok: true as const };
  }
);
