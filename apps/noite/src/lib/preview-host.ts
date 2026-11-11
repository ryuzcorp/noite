//! The base a preview environment's host hangs under. Environment labels are
//! one DNS label each (`<label>.<slug>.<base>`), so the only thing the control
//! plane needs to agree with the runner about is which base a page's own host
//! implies.

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** The base an environment's host hangs under for a page on `pageHost`: that
 * host itself when it is a DNS `CONTROL_EXTRA_HOSTS` entry (a LAN name such as
 * `noite.local` served over https by a local proxy, a Coolify domain), else
 * `BASE_DOMAIN`. The environment then stays on the page's own network and
 * scheme, and same-site with it. Mirrors `Config::tenant_bases` in
 * `apps/runner/src/config.rs`; bare IPs and entries with a port or path are
 * never bases. */
export const previewBase = (
  pageHost: string,
  baseDomain: string,
  extraHosts = ""
): string => {
  const host = (pageHost.split(":")[0] ?? "").toLowerCase();

  const match = extraHosts
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .replaceAll(/^\.+|\.+$/gu, "")
        .toLowerCase()
    )
    .find(
      (entry) =>
        entry === host &&
        !entry.includes(":") &&
        !entry.includes("/") &&
        !IPV4.test(entry)
    );

  return match ?? baseDomain;
};
