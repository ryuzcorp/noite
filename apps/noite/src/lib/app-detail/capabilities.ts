//! One role → capability table for the app pages. The runner re-checks every
//! call; this only keeps the UI's gates consistent, so "who can roll back"
//! has one answer instead of a `myRole === "push" || myRole === "admin"`
//! re-derived at every button.
import type { AppRole } from "../roles";

export interface Capabilities {
  /** Redeploy, roll back, stop a deploy, create/redeploy/delete an
   * environment, edit env vars, triage errors, push code. */
  readonly push: boolean;
  /** Toggle public access, delete an environment, change settings, rename,
   * transfer and delete the app. */
  readonly admin: boolean;
}

const CAPABILITIES = {
  admin: { admin: true, push: true },
  push: { admin: false, push: true },
  view: { admin: false, push: false },
} as const satisfies Record<AppRole, Capabilities>;

/** Gates for a role the detail has not loaded yet (or a non-member): no
 * capability, so controls stay off rather than popping in. */
const NONE: Capabilities = { admin: false, push: false };

/** The one capability table. Unknown/loading is `NONE`. */
export const capabilities = (role: AppRole | undefined): Capabilities =>
  role === undefined ? NONE : CAPABILITIES[role];
