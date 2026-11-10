//! App membership: a grant (`app_collaborator`) and a pending invitation
//! (`collaborator_invite`) are two rows that mean one thing per (app, email).
//! This module is the pure decision half; `lib/collaborators.ts` owns the
//! guarded writes.
//!
//! States and transitions:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> None
//!   None --> Invited: admin invites (role)
//!   Invited --> Member: invitee accepts (grant written, invite deleted)
//!   Invited --> None: invitee declines / admin revokes
//!   None --> Member: admin re-invites a known account, or the creator grant
//!   Member --> Member: admin changes the role (guarded)
//!   Member --> None: admin removes (guarded)
//! ```
//!
//! The invariant on every transition that *removes* an admin: the app keeps
//! at least one. It is checked here (`decideGrant`, `decideRemove`) and
//! enforced by one conditional SQL write per transition, so two admins racing
//! to demote each other cannot both win.
import { roleAtLeast } from "./roles";
import type { AppRole } from "./roles";

/** A grant or invitation row as the decisions see it. */
export interface RoleStamp {
  readonly createdAt: string;
  readonly role: AppRole;
}

/** Everything one transition needs. */
export interface MembershipSnapshot {
  /** How many admins the app has *now*, including this grant. */
  readonly adminCount: number;
  /** The account's current grant, or null. */
  readonly grant: RoleStamp | null;
  /** The pending invitation, or null. */
  readonly invite: RoleStamp | null;
}

/** What a role write decided. `Applies` covers both a change and a no-op
 * (the row already holds the role). */
export type GrantDecision =
  | { readonly _tag: "Applies"; readonly role: AppRole }
  | { readonly _tag: "Refused"; readonly reason: "last-admin" }
  | { readonly _tag: "Keep"; readonly role: AppRole };

export type RemoveDecision =
  | { readonly _tag: "Applies" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Refused"; readonly reason: "last-admin" };

/** Would writing `next` over `current` leave the app without an admin? */
const strandsAdmins = (
  current: AppRole | null,
  next: AppRole | null,
  adminCount: number
): boolean => current === "admin" && next !== "admin" && adminCount <= 1;

/** Invite / re-role an existing member. Downgrading the last admin is
 * refused; every other write applies. */
export const decideGrant = (snapshot: {
  readonly adminCount: number;
  readonly current: AppRole | null;
  readonly next: AppRole;
}): GrantDecision =>
  strandsAdmins(snapshot.current, snapshot.next, snapshot.adminCount)
    ? { _tag: "Refused", reason: "last-admin" }
    : { _tag: "Applies", role: snapshot.next };

/** Remove a member. Refused for the last admin. */
export const decideRemove = (snapshot: {
  readonly adminCount: number;
  readonly current: AppRole | null;
}): RemoveDecision => {
  if (snapshot.current === null) {
    return { _tag: "Missing" };
  }

  return strandsAdmins(snapshot.current, null, snapshot.adminCount)
    ? { _tag: "Refused", reason: "last-admin" }
    : { _tag: "Applies" };
};

/** Accept an invitation. The invitation's role applies when the account has
 * no grant yet or the invitation is the admin's newest word; an invitation
 * older than the grant never touches it (so accepting a stale invite can
 * never downgrade a promotion), and a downgrade that would strand the app is
 * refused. */
export const decideAccept = (snapshot: MembershipSnapshot): GrantDecision => {
  const { grant, invite } = snapshot;

  if (invite === null) {
    return { _tag: "Keep", role: grant?.role ?? "view" };
  }

  if (grant === null) {
    return { _tag: "Applies", role: invite.role };
  }

  if (invite.role === grant.role) {
    return { _tag: "Keep", role: grant.role };
  }

  if (roleAtLeast(invite.role, grant.role)) {
    return { _tag: "Applies", role: invite.role };
  }

  // A downgrade: only when the invitation was issued after the grant was
  // created. An older invitation is stale advice and is ignored.
  if (
    new Date(invite.createdAt).getTime() <= new Date(grant.createdAt).getTime()
  ) {
    return { _tag: "Keep", role: grant.role };
  }

  return strandsAdmins(grant.role, invite.role, snapshot.adminCount)
    ? { _tag: "Refused", reason: "last-admin" }
    : { _tag: "Applies", role: invite.role };
};
