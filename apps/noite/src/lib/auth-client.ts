import { apiKeyClient } from "@better-auth/api-key/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [apiKeyClient(), passkeyClient(), adminClient()],
});

/**
 * Full document navigation. Use after login/logout so action requests pick up
 * the new session cookie (SPA navigate can leave a stale client).
 */
export const hardNav = (path: string) => {
  window.location.replace(path);
};
