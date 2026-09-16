import { AdminPanel } from "$lib/admin-panel";
import { adminOverview } from "$lib/admin.server";
import { hardNav } from "$lib/auth-client";
import { SessionSplash } from "$lib/authed";
import { Breadcrumbs } from "$lib/breadcrumbs";
import { head } from "@ilha/router";
import { atom, watch } from "ilha";

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- browser has no Bun.sleep; setTimeout delay needs a Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Instance administration — admin role or NOITE_ADMIN_EMAIL only.
 * Everyone else bounces to /apps (server actions enforce the same gate).
 * Retries the check briefly: first paint can race the session cookie. */
export default function GodMode() {
  head({ title: "God Mode · Noite" });
  const ready = atom(false);
  const email = atom("");

  watch.once(() => {
    void (async () => {
      try {
        for (let i = 0; i < 10; i += 1) {
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential readiness poll; Promise.all would defeat the early-exit
            const overview = await adminOverview();
            if (overview.isAdmin) {
              email.set(overview.email);
              ready.set(true);
              return;
            }
          } catch {
            // A throw here is a broken check, not a denial — retry once
            // more before giving up below.
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
          await sleep(100);
        }
        hardNav("/apps");
      } catch {
        hardNav("/apps");
      }
    })();
  });

  if (!ready()) {
    return <SessionSplash />;
  }
  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <Breadcrumbs trail={[{ label: "God Mode" }]} />
      <div class="w-full max-w-2xl">
        <AdminPanel email={email()} />
      </div>
    </div>
  );
}
