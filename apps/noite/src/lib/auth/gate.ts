//! The dashboard session gate: what the layout shows while it decides whether
//! there is a session, as one value instead of `data` × `loading` × `error`.
//!
//! | state      | the page shows                      | next |
//! | ---------- | ----------------------------------- | ---- |
//! | `Ssr`      | the skeleton (no fetch runs on SSR)  | `Read` |
//! | `Checking` | the skeleton, `attempt` of `BUDGET`  | `Read`, `ReadFailed` |
//! | `Authed`   | the dashboard                        | `SignedOut` |
//! | `SignedOut`| a redirect to `/login`              | `Read` |
//! | `Failed`   | an error with a Retry button         | `Retry` |
//!
//! Two rules are fixed here, at the one transition:
//! - a *failed* read is `Failed` with a retry. It used to throw out of the
//!   watcher, leaving the skeleton up forever with no way out (the gate never
//!   consulted the resource's error);
//! - only a completed read that still has no user, `BUDGET` times, is
//!   `SignedOut` — the post-registration cookie race, not an outage.
import { Data } from "effect";

import type { SessionView } from "../resources";

/** How many times the gate re-reads the session before calling it signed out.
 * The passkey flow can mint a session a moment after the first answer. */
export const SESSION_RETRY_BUDGET = 20;

export type Gate = Data.TaggedEnum<{
  Authed: { readonly session: SessionView };
  Checking: { readonly attempt: number };
  /** A read that failed (store outage, network, 5xx): distinct from signed
   * out, so the page offers a retry instead of bouncing to /login. */
  Failed: { readonly message: string };
  SignedOut: Record<never, never>;
  Ssr: Record<never, never>;
}>;

export const GateState = Data.taggedEnum<Gate>();

export type GateEvent = Data.TaggedEnum<{
  /** A read completed; `session` is null when the cookie is not readable. */
  Read: { readonly session: SessionView | null };
  ReadFailed: { readonly message: string };
  Retry: Record<never, never>;
}>;

export const GateEvt = Data.taggedEnum<GateEvent>();

/** The one transition. */
export const gateTransition = (state: Gate, event: GateEvent): Gate => {
  switch (event._tag) {
    case "ReadFailed": {
      return GateState.Failed({ message: event.message });
    }

    case "Retry": {
      return GateState.Checking({ attempt: 0 });
    }

    default: {
      if (event.session !== null) {
        return GateState.Authed({ session: event.session });
      }

      // A session that disappeared under a painted page (the impersonated
      // session expired, or the cookie was cleared in another tab) signs out:
      // the gate must never keep rendering user data from a dead session.
      if (state._tag === "Authed") {
        return GateState.SignedOut();
      }

      // Only a checking gate retries; any other state that reads null is
      // already settled (signed out, or a page that has painted).
      if (state._tag !== "Checking" && state._tag !== "Ssr") {
        return state;
      }

      const attempt = state._tag === "Checking" ? state.attempt + 1 : 1;

      return attempt >= SESSION_RETRY_BUDGET
        ? GateState.SignedOut()
        : GateState.Checking({ attempt });
    }
  }
};
