//! The control plane as a first-class "app": a reserved id the admin sees in
//! `/apps` whose only storage resource is the control D1 (`noite-control`),
//! browsed in-process through the worker's own D1 binding. It is NOT a runner
//! app: no runner row exists, and every control-D1 action re-checks admin +
//! non-impersonation server-side (see lib/control-d1.server.ts).

/** Reserved pseudo app id. `_control` is already in the runner's
 * `RESERVED_SLUGS` (apps/runner/src/lifecycle.rs), so no real app or slug can
 * ever collide with it. */
export const CONTROL_APP_ID = "_control";

/** Display name on the card and the detail header. */
export const CONTROL_APP_NAME = "Noite";

/** Subtitle under the name. */
export const CONTROL_APP_SUBTITLE = "admin";

/** The control D1's database name (apps/noite/cloudflare.config.ts binds it as
 * `DB`). Its tables are the auth + collaborator state in lib/db.ts. */
export const CONTROL_APP_DATABASE_ID = "noite-control";

/** True for the reserved control app id. */
export const isControlApp = (appId: string): boolean =>
  appId === CONTROL_APP_ID;

/** Deployment generation marker, stamped at build time (`vite.config.ts`
 * defines it from the git sha) so adoption is verifiable — `/health` exposes
 * it — without anyone remembering to bump a number. Without this, worker-code
 * version is indistinguishable from outside and every diagnosis branches. */
// `typeof` is the one form that is safe when the define is absent.
export const CONTROL_BUILD =
  typeof __CONTROL_BUILD__ === "undefined" ? "dev" : __CONTROL_BUILD__;
