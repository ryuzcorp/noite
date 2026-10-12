/** The browser `Origin` a control route accepts: this site (the control UI's
 * own fetch), plus the configured auth URL when a proxy makes the two differ.
 * `Origin`-less callers (non-browser API clients) are allowed; routes that
 * only the control UI calls must also require the header to be present. */
export const originAllowed = (request: Request, env: KitEnv): boolean => {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  try {
    if (origin === new URL(request.url).origin) {
      return true;
    }
  } catch {
    return false;
  }
  if (!env.BETTER_AUTH_URL) {
    return false;
  }
  try {
    return origin === new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    // A malformed BETTER_AUTH_URL already fails loudly on the auth path; it
    // does not widen what these endpoints accept.
    return false;
  }
};
