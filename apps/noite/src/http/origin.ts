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

/** Cross-site gate for cookie-authenticated, state-changing browser requests
 * (control actions, the R2 upload): a tenant page on a sibling subdomain is
 * the same *site*, so `SameSite=Lax` still attaches the session cookie on a
 * `text/plain` POST that needs no CORS preflight. When the browser sends an
 * `Origin`, it must be this site's own origin (or the configured
 * `BETTER_AUTH_URL` origin behind a proxy); otherwise the `Sec-Fetch-Site`
 * hint must say `same-origin`/`none`. Requests with neither header are
 * non-browser API clients (an agent's HTTP client, Playwright's request
 * context) and pass. `Origin: null` (a sandboxed frame) is always refused. */
export const isSameOriginAction = (request: Request, env: KitEnv): boolean => {
  const origin = request.headers.get("origin");

  if (origin !== null) {
    return origin !== "null" && originAllowed(request, env);
  }

  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();

  if (site === null || site === undefined || site === "") {
    return true;
  }

  return site === "same-origin" || site === "none";
};
