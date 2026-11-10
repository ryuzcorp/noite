import { useRouter } from "@ilha/void";
import * as Atom from "effect/reactivity/Atom";
import { atom, watch } from "ilha";
import type { View } from "ilha";

import { authClient } from "../auth-client";
import { errorMessage } from "../errors";
import { resourceValue } from "../resource";
import { session as sessionResource } from "../resources";
import { sleep } from "../sleep";
import { DashboardSkeleton } from "../ui/skeletons";
import { GateEvt, GateState, gateTransition } from "./gate";
import type { Gate, GateEvent } from "./gate";
import { takeImpersonationReturn } from "./impersonation";
import { invalidateSession } from "./session";

/** Dashboard-chrome skeleton while the gate resolves. */
export const SessionSplash = () => <DashboardSkeleton />;

/** How long the gate waits between cookie-readiness reads. */
const RETRY_INTERVAL_MS = 50;

/** Re-read only when the tab is actually in the foreground. */
const rereadWhenVisible = (reread: () => void) => (): void => {
  if (document.visibilityState === "visible") {
    reread();
  }
};

/**
 * Session gate for the dashboard. Renders `fallback` until the session cookie
 * is readable, then renders `children`. Redirects to /login if it never
 * becomes readable — mounted once in the layout so every view is covered.
 *
 * The states and transitions live in `./gate` (`GateState`); a failed read
 * paints an explicit error with Retry instead of the skeleton it used to
 * leave up forever.
 */
export const Authed = ({
  children,
  fallback = <SessionSplash />,
}: {
  children: View;
  fallback?: View;
}) => {
  const router = useRouter();
  const res = sessionResource();
  const gate = atom<Gate>(GateState.Ssr());
  const returning = atom(false);
  const returnError = atom("");

  const dispatch = (event: GateEvent): Gate => {
    const next = gateTransition(gate(), event);

    gate.set(next);

    return next;
  };

  /** Apply a settled gate: a signed-out state always leaves for the login
   * page (the initial pass and a later re-read alike). */
  const settle = (next: Gate): void => {
    if (next._tag === "SignedOut") {
      router.visit("/login");
    }
  };

  /** One re-read outside the initial pass: the impersonation watch below. */
  const refresh = async (): Promise<void> => {
    try {
      await res.refetch();
      settle(
        dispatch(GateEvt.Read({ session: resourceValue(res.state()) ?? null }))
      );
    } catch (error) {
      dispatch(GateEvt.ReadFailed({ message: errorMessage(error) }));
    }
  };

  /** Read the session, retrying only while the gate is still `Checking`, and
   * settle on Authed / SignedOut / Failed. Never throws: a rejected refetch is
   * the `Failed` state, not an abandoned watcher. */
  const check = async (signal?: AbortSignal): Promise<void> => {
    for (;;) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; parallel reads would defeat the early exit
        await res.refetch();
        // SAFETY: `refetch` resolved, so the state carries a value; a null
        // value is the "cookie not readable yet" case the gate retries.
        const session = resourceValue(res.state()) ?? null;
        const next = dispatch(GateEvt.Read({ session }));

        if (next._tag !== "Checking") {
          settle(next);

          return;
        }
      } catch (error) {
        dispatch(GateEvt.ReadFailed({ message: errorMessage(error) }));

        return;
      }

      if (signal?.aborted) {
        return;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
      await sleep(RETRY_INTERVAL_MS);
    }
  };

  watch.once(async ({ signal }) => {
    if (typeof window === "undefined") {
      // SSR: the session resolves client-side (resources never fetch on
      // the server); the gate paints its fallback until hydration lands.
      return;
    }

    // A painted snapshot counts as the first read: only a cold gate fetches.
    const painted = resourceValue(res.state());

    if (painted?.user) {
      dispatch(GateEvt.Read({ session: painted }));

      return;
    }

    dispatch(GateEvt.Retry());
    await check(signal);
  });

  const stopImpersonating = async () => {
    returning.set(true);
    returnError.set("");

    try {
      const result = await authClient.admin.stopImpersonating({});

      if (result.error) {
        returnError.set(
          result.error.message ?? "Failed to return to admin session"
        );
        returning.set(false);

        return;
      }

      invalidateSession();
      // Back where the admin started the impersonation (the admin home when
      // that is unknown), never a page they did not come from.
      router.visit(takeImpersonationReturn("/apps/_control?t=users"));
    } catch (error) {
      returnError.set(errorMessage(error));
      returning.set(false);
    }
  };

  // An impersonated session expires server-side, and the admin's tab has no
  // other reason to re-read: when the tab comes back into view, re-read once
  // so the banner cannot outlive the session it describes. Event-driven, no
  // polling timer.
  const impersonating = atom(
    Atom.map(
      (state: Gate) =>
        state._tag === "Authed" && state.session.session.impersonatedBy !== null
    )(gate.atom)
  );

  watch(impersonating, (on, { signal }) => {
    if (!on) {
      return;
    }

    const reread = rereadWhenVisible(() => {
      void refresh();
    });

    document.addEventListener("visibilitychange", reread, { signal });
    window.addEventListener("focus", reread, { signal });
  });

  const state = gate();

  if (state._tag === "Failed") {
    return (
      <div class="mx-auto flex w-full max-w-md flex-col items-start gap-3 p-6">
        <h1 class="m-0 text-lg font-semibold">Couldn't load your session</h1>
        <p class="m-0 text-sm opacity-70">{state.message}</p>
        <p class="m-0 text-sm opacity-70">
          This is usually a temporary database or network problem — your account
          is fine.
        </p>
        <button
          type="button"
          class="btn btn-sm btn-neutral"
          onclick={() => {
            dispatch(GateEvt.Retry());
            void check();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (state._tag !== "Authed") {
    return fallback;
  }

  const { session } = state;
  const impersonated = session.session.impersonatedBy !== null;

  return (
    <>
      {impersonated ? (
        <div class="bg-warning text-warning-content px-4 py-2 text-sm">
          <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2">
            <span>Impersonating {session.user.email}</span>
            <span class="flex items-center gap-2">
              {returnError() ? <span>{returnError()}</span> : null}
              <button
                type="button"
                class="btn btn-sm"
                disabled={returning()}
                onclick={() => {
                  void stopImpersonating();
                }}
              >
                Return to admin
              </button>
            </span>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
};
