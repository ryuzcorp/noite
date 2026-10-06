import { authClient } from "../auth-client";
import { resetUserCaches } from "../resources";

/** Direct session read for imperative poll loops (login-panel's
 * `waitForSession` races the freshly-set auth cookie). Reactive code
 * should use the `session()` resource instead — it dedupes. */
export const fetchSession = () => authClient.getSession();

/** Auth state changed (sign-in, sign-out, impersonation start/stop): drop
 * the session and every other user-scoped cache so the persistent layout
 * and any live panel refetch as the new user. */
export const invalidateSession = (): void => {
  resetUserCaches();
};
