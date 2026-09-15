import { atom, watch } from "ilha";
import type { View } from "ilha";

import { authClient, hardNav } from "./auth-client";

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- browser has no Bun.sleep; setTimeout delay needs a Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Session gate for dashboard panels. Renders `fallback` until the session
 * cookie is readable, then renders `then`. Redirects to /login if it never
 * becomes readable — shared by home, apps list, and new-app views.
 */
export const Authed = ({
  children,
  fallback = <p class="opacity-70">Loading…</p>,
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
