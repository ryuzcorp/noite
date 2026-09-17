import { atom, watch } from "ilha";
import type { View } from "ilha";

import { authClient, hardNav } from "./auth-client";
import { DashboardSkeleton } from "./skeletons";

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- browser has no Bun.sleep; setTimeout delay needs a Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface CachedSession {
  email: string;
  impersonated: boolean;
  verifiedAt: number;
}

/** Last verified session (module scope — survives SPA navigations, dies
 * on document reload). Navigations inside the TTL skip the gate entirely;
 * every mount still revalidates silently so a dead session bounces fast.
 * Server actions enforce auth regardless — this only gates pixels. */
let sessionCache: CachedSession | null = null;
const SESSION_TTL_MS = 60_000;

export const clearSessionCache = (): void => {
  sessionCache = null;
};

interface SessionWithImpersonation {
  impersonatedBy?: unknown;
}

const readImpersonated = (
  session: SessionWithImpersonation | null | undefined,
  fallbackEmail: string
) => {
  // The admin plugin adds an optional impersonatedBy id to sessions it
  // creates; presence means this session is impersonated.
  const impersonated =
    session?.impersonatedBy !== undefined && session.impersonatedBy !== null;
  return {
    email: fallbackEmail,
    impersonated,
  };
};

/**
 * Session gate for the dashboard. Renders `fallback` until the session
 * cookie is readable, then renders `then`. Redirects to /login if it never
 * becomes readable — mounted once in the layout so every view is covered.
 */
/** Dashboard-chrome skeleton while the gate resolves. */
export const SessionSplash = () => <DashboardSkeleton />;

export const Authed = ({
  children,
  fallback = <SessionSplash />,
}: {
  children: View;
  fallback?: View;
}) => {
  const ready = atom(false);
  const denied = atom(false);
  const impersonatedEmail = atom("");
  const returning = atom(false);
  const returnError = atom("");

  watch.once(() => {
    void (async () => {
      // Fast path: verified recently — render instantly, revalidate silently.
      const cached = sessionCache;
      if (cached && Date.now() - cached.verifiedAt < SESSION_TTL_MS) {
        if (cached.impersonated) {
          impersonatedEmail.set(cached.email);
        }
        ready.set(true);
        const { data } = await authClient.getSession();
        if (data?.user) {
          const seen = readImpersonated(data.session, data.user.email);
          sessionCache = {
            email: data.user.email,
            impersonated: seen.impersonated,
            verifiedAt: Date.now(),
          };
          if (seen.impersonated) {
            impersonatedEmail.set(data.user.email);
          }
          return;
        }
        sessionCache = null;
        hardNav("/login");
        return;
      }
      // Slow path (initial load): retry briefly — first paint after
      // register can race the session cookie.
      for (let i = 0; i < 20; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
        const { data } = await authClient.getSession();
        if (data?.user) {
          const seen = readImpersonated(data.session, data.user.email);
          sessionCache = {
            email: data.user.email,
            impersonated: seen.impersonated,
            verifiedAt: Date.now(),
          };
          if (seen.impersonated) {
            impersonatedEmail.set(data.user.email);
          }
          ready.set(true);
          return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
        await sleep(50);
      }
      // No session: leave nothing dashboard-shaped on screen and bounce.
      denied.set(true);
      hardNav("/login");
    })();
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
      hardNav("/god-mode");
    } catch (error) {
      returnError.set(error instanceof Error ? error.message : String(error));
      returning.set(false);
    }
  };

  if (!ready()) {
    return denied() ? null : fallback;
  }
  return (
    <>
      {impersonatedEmail() ? (
        <div class="bg-warning text-warning-content px-4 py-2 text-sm">
          <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2">
            <span>Impersonating {impersonatedEmail()}</span>
            <span class="flex items-center gap-2">
              {returnError() ? <span>{returnError()}</span> : null}
              <button
                type="button"
                class="btn btn-xs"
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
