//! The control UI's environment access gate (`/api/env-auth`): the pure pieces
//! of the hand-off the runner's edge 302s a browser into. The edge sends
//! `<control>/api/env-auth?env=<envId>&app=<appId>&return=<absolute env URL>`;
//! this module decides where the browser goes next — and never trusts the
//! host inside `return` (the environment host is always rebuilt from the
//! environment's own label, the app's slug and the base).
//!
//! Client-safe on purpose: `login-panel` reuses `sameOriginPath` to come back
//! to this route after sign-in.

/** Control characters (tab, newline, CR, NUL, DEL) anywhere in a URL: the
 * WHATWG parser strips several of them *before* parsing, which re-forms a
 * protocol-relative URL (`"/\n//evil.example"` becomes `https://evil.example/`). */
const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
};

/** A rooted, same-origin path from `raw`, or null when it is not one. A
 * protocol-relative value (`//host`) resolves to another origin, a backslash
 * is normalized to `/` by browsers, and control characters are stripped by
 * the URL parser — all three are refused. */
export const sameOriginPath = (raw: string): string | null => {
  const trimmed = raw.trim();

  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    hasControlCharacter(trimmed)
  ) {
    return null;
  }

  return trimmed;
};

/** The environment's own host: `<label>.<slug>.<base>`, with the dev port when
 * the base is a `*.localhost` name. */
export const environmentHost = (
  label: string,
  slug: string,
  base: string,
  port: string
): string => `${label}.${slug}.${base}${port === "" ? "" : `:${port}`}`;

/** The path (+query) of `raw` when it is an absolute URL on `expectedHost`,
 * else `/`. The absolute-URL check is what makes the redirect closed: a
 * `return` naming another host never leaves this environment. */
export const environmentReturnPath = (
  raw: string,
  expectedHost: string
): string => {
  if (raw.trim() === "") {
    return "/";
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return "/";
  }

  if (url.host.toLowerCase() !== expectedHost.toLowerCase()) {
    return "/";
  }

  return `${url.pathname}${url.search}`;
};

/** Where the control UI sends the browser once it holds a grant: the
 * environment's own `/__noite/auth`, with the token and the path to resume. */
export const envAuthLocation = (
  origin: string,
  token: string,
  returnPath: string
): string =>
  `${origin}/__noite/auth?token=${encodeURIComponent(token)}&return=${encodeURIComponent(returnPath)}`;
