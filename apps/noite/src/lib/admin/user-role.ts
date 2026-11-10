//! The admin Users tab's view of a stored `user.role`. The column is free
//! text, and the panel coerced it with `role === "admin" ? "admin" : "user"`:
//! a corrupted value became indistinguishable from a real regular user. This
//! keeps the coercion but reports whether it happened, so the row can say so
//! and refuse the role toggle instead of silently rewriting the value.
export interface AdminRoleView {
  /** False when the stored value was neither `admin` nor `user`. */
  readonly known: boolean;
  readonly role: "admin" | "user";
}

/** The one coercion: known values pass through, anything else reads as `user`
 * and is flagged. A null role is the column default, not corruption. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the role column is free text at the boundary; this function IS its parser.
export const adminRoleOf = (raw: unknown): AdminRoleView => {
  if (raw === "admin") {
    return { known: true, role: "admin" };
  }

  if (raw === "user" || raw === null || raw === undefined) {
    return { known: true, role: "user" };
  }

  return { known: false, role: "user" };
};
