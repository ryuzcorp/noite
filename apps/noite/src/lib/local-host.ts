/** Whether a host or base domain is the `localhost` family: bare `localhost`
 * or any `*.localhost` name. Browsers resolve every `*.localhost` host to
 * loopback and treat it as a secure context, so the dev stack is served from
 * `noite.localhost` — one registrable domain for the control UI, api, git,
 * tenants and previews, which is what makes the workspace frame same-site.
 *
 * Every dev-only shortcut keys on this predicate, never on the literal
 * `localhost`: the plain-http preview scheme, the dev-console OTP fallback,
 * the default-secret refusal. Mirrors `is_localhost_domain` in
 * `apps/runner/src/config.rs`. */
export const isLocalhostDomain = (domain: string): boolean => {
  const trimmed = domain.trim().toLowerCase().replace(/\.+$/u, "");

  return trimmed === "localhost" || trimmed.endsWith(".localhost");
};
