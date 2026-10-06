import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";
import type { View } from "ilha";

import { authClient } from "../auth-client";
import { errorMessage } from "../errors";
import { session as sessionResource } from "../resources";
import { sleep } from "../sleep";
import { DashboardSkeleton } from "../ui/skeletons";
import { invalidateSession } from "./session";

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
  const res = sessionResource();
  const returning = atom(false);
  const returnError = atom("");
  watch.once(async ({ signal }) => {
    // Wait for the first answer however long it takes: refetch() joins
    // the in-flight request, so a slow get-session never counts against
    // the retry budget below (sleeping through it bounced real users).
    if (res.loading() || res.data() === undefined) {
      await res.refetch();
    }
    // Post-registration cookie race: the first answer can arrive before
    // the session cookie is readable, so retry briefly before bouncing.
    for (let i = 0; i < 20 && !res.data()?.user; i += 1) {
      if (signal.aborted) {
        return;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
      await sleep(50);
      if (signal.aborted) {
        return;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- same poll cycle: sleep, then re-read
      await res.refetch();
    }
    if (!signal.aborted && !res.data()?.user) {
      navigate("/login");
    }
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
      navigate("/apps/_control?t=users");
    } catch (error) {
      returnError.set(errorMessage(error));
      returning.set(false);
    }
  };

  const data = res.data();
  const user = data?.user;
  if (!data || !user) {
    return fallback;
  }
  const seen = readImpersonated(data.session, user.email);
  return (
    <>
      {seen.impersonated ? (
        <div class="bg-warning text-warning-content px-4 py-2 text-sm">
          <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2">
            <span>Impersonating {seen.email}</span>
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
