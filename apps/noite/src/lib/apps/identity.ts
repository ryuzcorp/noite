//! Pure app identity helpers: slug shaping, avatar initials, presence tone
//! and the reachable host/URL for a stored subdomain. No UI, no resources —
//! components and pages both import these.

import { kebabCase } from "scule";

// Letters, digits, plus hyphens: fold whitespace, drop other symbols,
// and trim edge hyphens so live slugs match the create/rename gate.
export const slugifyName = (value: string): string =>
  kebabCase(value.replaceAll(/\s+/gu, "-"))
    .replaceAll(/[^A-Za-z0-9-]+/gu, "")
    .replaceAll(/-{2,}/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48);

/** Initials for the avatar placeholder: first letters of the first two
 * words ("My Service" → "MS", "test" → "T"). */
export const initials = (name: string): string => {
  const parts = name
    .trim()
    .split(/\s+/u)
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return "?";
  }
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase() || "?";
};

/** Presence dot tone: running = green, error = red, sleeping (scale to
 * zero: healthy, parked until its next request) = neutral, rest = yellow. */
export const presenceTone = (status: string): string => {
  if (status === "running") {
    return "status-success";
  }
  if (status === "sleeping") {
    return "status-neutral";
  }
  if (status === "failed" || status === "error") {
    return "status-error";
  }
  return "status-warning";
};

/** Reachable host for a stored subdomain on the current page's network.
 * Stored subdomains anchor on the configured base (dev: slug.localhost).
 * When this UI is served from outside that family (dev-host LAN name/IP),
 * rebase the slug onto the current host so the link stays on this network.
 * Loopback forms and same-family hosts keep the stored value untouched. */
export const appHost = (subdomain: string): string => {
  const { hostname } = window.location;
  const host = hostname.toLowerCase();
  const dot = subdomain.indexOf(".");
  const base = dot === -1 ? "" : subdomain.slice(dot + 1).toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";
  if (loopback || host === base || (base !== "" && host.endsWith(`.${base}`))) {
    return subdomain;
  }
  const slug = dot === -1 ? subdomain : subdomain.slice(0, dot);
  return `${slug}.${hostname}`;
};

/** Live-app URL on the current host (mirrors LiveAppStatus in app-detail).
 * Dev carries the port over http; prod (no port) links plain https. */
export const appUrl = (subdomain: string): string => {
  const { port } = window.location;
  const host = appHost(subdomain);
  return port ? `http://${host}:${port}` : `https://${host}`;
};
