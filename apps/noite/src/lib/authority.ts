//! Instance-admin authority: the ONE predicate every server gate, client
//! surface and the sidebar reads. Before this module the same question was
//! answered in six places (server `requireAdmin`, `requireControlAdmin`,
//! `controlAccessRefusal`, the client `isInstanceAdmin`, the sidebar and the
//! control stream gate), each with a slightly different rule.
//!
//! | state           | may administer | how a session gets here                        |
//! | --------------- | -------------- | --------------------------------------------- |
//! | `Anonymous`     | no             | no session cookie                             |
//! | `Banned`        | no             | `user.banned`                                 |
//! | `Pending`       | no             | `user.status == "pending"` (the waitlist)     |
//! | `Impersonating` | no             | `session.impersonatedBy` is set               |
//! | `InstanceAdmin` | yes            | `role == "admin"`, or the `NOITE_ADMIN_EMAIL` |
//! | `Plain`         | no             | signed in, `role != "admin"`, not the anchor  |
//!
//! Precedence (one-way, no return): `Anonymous` -> `Banned` ->
//! `Pending` -> `Impersonating` -> `InstanceAdmin` | `Plain`. An
//! impersonated session is never an instance admin, so an admin touring
//! another account cannot read or write the auth database; the same session
//! still renders that account's apps through the collaborator gate. A
//! pending account never administers either: approval flips `user.status`
//! to `active` first (a pending row can never carry the admin role).
//!
//! The wire form (`AdminOverview.authority`) is the kebab-cased tag; the
//! client rebuilds the union with `authorityFromWire`.
import { Data } from "effect";

/** One closed type for "what may this session do to the instance". */
export type InstanceAuthority = Data.TaggedEnum<{
  Anonymous: Record<never, never>;
  Banned: Record<never, never>;
  Impersonating: { readonly by: string };
  InstanceAdmin: { readonly via: "anchor" | "role" };
  Pending: Record<never, never>;
  Plain: Record<never, never>;
}>;

export const Authority = Data.taggedEnum<InstanceAuthority>();

/** Everything the predicate needs, all of it already on the request. */
export interface AuthorityInput {
  /** The normalised `NOITE_ADMIN_EMAIL` anchor, or null when unset. */
  readonly adminEmail: string | null;
  readonly banned?: boolean | null | undefined;
  readonly email: string | null | undefined;
  /** The admin plugin's impersonation marker (`session.impersonatedBy`). */
  readonly impersonatedBy: string | null;
  /** The better-auth user's role field (free text in the database). */
  readonly role: unknown;
  /** The waitlist state (`user.status`): only `"pending"` refuses. */
  readonly status?: string | null | undefined;
}

const ROLE_ADMIN = "admin";

/** The one authority constructor: total over its input, no throws. */
export const authorityOf = (input: AuthorityInput): InstanceAuthority => {
  const email = input.email?.trim().toLowerCase() ?? "";

  if (email === "") {
    return Authority.Anonymous();
  }

  if (input.banned === true) {
    return Authority.Banned();
  }

  if (input.status === "pending") {
    return Authority.Pending();
  }

  if (input.impersonatedBy !== null) {
    return Authority.Impersonating({ by: input.impersonatedBy });
  }

  const anchored =
    input.adminEmail !== null &&
    input.adminEmail.trim().toLowerCase() === email;

  if (input.role === ROLE_ADMIN) {
    return Authority.InstanceAdmin({ via: "role" });
  }

  return anchored
    ? Authority.InstanceAdmin({ via: "anchor" })
    : Authority.Plain();
};

/** May this session administer the instance (control data browser, admin
 * home, admin actions)? Every surface asks this and nothing else. */
export const mayAdministerInstance = (authority: InstanceAuthority): boolean =>
  authority._tag === "InstanceAdmin";

/** The anchor handed out by `resolveAdminEmail`, or null. Split out so the
 * predicate stays pure: server callers pass it in, the client gets it on the
 * overview. */
export type AuthorityWire =
  | "anonymous"
  | "banned"
  | "impersonating"
  | "instance-admin"
  | "pending"
  | "plain";

/** The wire tag for an authority (kebab case of the union tag). */
export const authorityWire = (authority: InstanceAuthority): AuthorityWire => {
  if (authority._tag === "InstanceAdmin") {
    return "instance-admin";
  }

  // SAFETY: the remaining tags (Anonymous, Banned, Impersonating, Pending,
  // Plain) lowercase to exactly their wire values.
  return authority._tag.toLowerCase() as AuthorityWire;
};

/** Rebuild the union from the wire tag. `via` is presentation-only on the
 * client (the badge shows "admin"), so it defaults to `role`. */
export const authorityFromWire = (wire: AuthorityWire): InstanceAuthority => {
  switch (wire) {
    case "instance-admin": {
      return Authority.InstanceAdmin({ via: "role" });
    }

    case "impersonating": {
      return Authority.Impersonating({ by: "" });
    }

    case "banned": {
      return Authority.Banned();
    }

    case "pending": {
      return Authority.Pending();
    }

    case "plain": {
      return Authority.Plain();
    }

    default: {
      return Authority.Anonymous();
    }
  }
};

/** The client's single read of `/api/admin/adminOverview`: one predicate for
 * the side bar and the control page. A missing overview (still
 * loading) is not an admin. */
export const overviewAuthority = (
  overview: { readonly authority: AuthorityWire } | undefined
): InstanceAuthority =>
  overview === undefined
    ? Authority.Plain()
    : authorityFromWire(overview.authority);
