//! The impersonation cycle's two implicit values, made explicit:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Self
//!   Self --> Impersonating: admin clicks Impersonate (return path remembered)
//!   Impersonating --> Returning: "Return to admin"
//!   Returning --> Self: cookie swapped, visit the remembered path
//!   Impersonating --> Self: the impersonated session expires (the gate re-reads on focus)
//! ```
//!
//! The return path used to be hard-coded to the admin home, so an admin who
//! started from `/account` came back somewhere else. It is remembered per tab
//! in `sessionStorage` (never a cookie: it must not outlive the tab) and only
//! ever a rooted, same-origin path.
import { sameOriginPath } from "../env-auth";

/** sessionStorage key. Scoped to the tab: two admins in two tabs do not share
 * a return path. */
const RETURN_KEY = "noite.impersonation.return";

/** Where the admin came from, before the impersonation navigation. */
export const rememberImpersonationReturn = (): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      RETURN_KEY,
      `${window.location.pathname}${window.location.search}`
    );
  } catch {
    // Storage unavailable (private mode, quota): the fallback still works.
  }
};

/** Where "Return to admin" goes: the remembered path once, then the fallback.
 * Only a rooted, same-origin path is accepted. */
export const takeImpersonationReturn = (fallback: string): string => {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const remembered = window.sessionStorage.getItem(RETURN_KEY);

    window.sessionStorage.removeItem(RETURN_KEY);

    return remembered === null
      ? fallback
      : (sameOriginPath(remembered) ?? fallback);
  } catch {
    return fallback;
  }
};
