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

  watch.once(() => {
    void (async () => {
      // Retry briefly — first paint after register can race the session cookie.
      for (let i = 0; i < 20; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
        const { data } = await authClient.getSession();
        if (data?.user) {
          ready.set(true);
          return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
        await sleep(50);
      }
      hardNav("/login");
    })();
  });

  return ready() ? children : fallback;
};
