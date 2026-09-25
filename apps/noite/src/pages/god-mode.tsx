import {
  AdminAppsPanel,
  AdminInvitesPanel,
  AdminUsersPanel,
} from "$lib/admin-panel";
import { adminOverview } from "$lib/admin.server";
import { SessionSplash } from "$lib/authed";
import { sleep } from "$lib/sleep";
import { head, navigate, useRoute } from "@ilha/router";
import { atom, watch } from "ilha";

const TABS = [
  { id: "users", label: "Users" },
  { id: "apps", label: "Apps" },
  { id: "invites", label: "Invites" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Instance administration — admin role or NOITE_ADMIN_EMAIL only.
 * Everyone else bounces to /apps (server actions enforce the same gate).
 * Retries the check briefly: first paint can race the session cookie.
 *
 * Same tab mechanism as the app detail page: the active tab lives in ?t= so a
 * refresh (or a shared link) restores it, and each tab fetches only its own
 * list. */
export default function GodMode() {
  head({ title: "God Mode · Noite" });
  const route = useRoute();
  const ready = atom(false);
  const email = atom("");

  const activeTab = (): TabId => {
    const t = new URLSearchParams(route.search()).get("t");
    return TABS.find((tab) => tab.id === t)?.id ?? "users";
  };
  const selectTab = (tab: TabId) => {
    navigate(`${route.path()}?t=${tab}`, { replace: true });
  };

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
        navigate("/apps");
      } catch {
        navigate("/apps");
      }
    })();
  });

  if (!ready()) {
    return <SessionSplash />;
  }
  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <div role="tablist" class="tabs tabs-border w-fit">
        {TABS.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab() === tab.id ? "true" : "false"}
            class={`tab ${activeTab() === tab.id ? "tab-active" : ""}`}
            onclick={() => {
              selectTab(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab() === "users" ? <AdminUsersPanel email={email()} /> : null}
      {activeTab() === "apps" ? <AdminAppsPanel /> : null}
      {activeTab() === "invites" ? <AdminInvitesPanel /> : null}
    </div>
  );
}
