import { atom, watch } from "ilha";
import type { View } from "ilha";

import { authClient, hardNav } from "./auth-client";

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- browser has no Bun.sleep; setTimeout delay needs a Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Session gate for the dashboard. Renders `fallback` until the session
 * cookie is readable, then renders `then`. Redirects to /login if it never
 * becomes readable — mounted once in the layout so every view is covered.
 */
/** Full-page session splash: spinner + brand while the gate resolves. */
export const SessionSplash = () => (
  <div class="grid min-h-[60vh] place-items-center">
    <div class="flex flex-col items-center gap-3">
      <span class="loading loading-spinner loading-lg text-primary" />
      <p class="m-0 text-sm opacity-70">Checking session…</p>
    </div>
  </div>
);

export const Authed = ({
  children,
  fallback = <SessionSplash />,
}: {
  children: View;
  fallback?: View;
}) => {
  const ready = atom(false);
  const impersonatedEmail = atom("");
  const returning = atom(false);
  const returnError = atom("");

  watch.once(() => {
    void (async () => {
      // Retry briefly — first paint after register can race the session cookie.
      for (let i = 0; i < 20; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
        const { data } = await authClient.getSession();
        if (data?.user) {
          // SAFETY: the admin plugin adds an optional impersonatedBy id to
          // sessions it creates; presence means this session is impersonated.
          const session = data.session as
            | { impersonatedBy?: unknown }
            | null
            | undefined;
          if (session?.impersonatedBy) {
            impersonatedEmail.set(data.user.email);
          }
          ready.set(true);
          return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
        await sleep(50);
      }
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
    return fallback;
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
