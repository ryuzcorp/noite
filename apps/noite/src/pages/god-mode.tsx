import {
  AdminAppsPanel,
  AdminInvitesPanel,
  AdminUsersPanel,
} from "$lib/admin-panel";
import { SessionSplash } from "$lib/authed";
import { adminStatus } from "$lib/resources";
import { head, navigate, searchParam } from "@ilha/router";
import { watch } from "ilha";

const TABS = [
  { id: "users", label: "Users" },
  { id: "apps", label: "Apps" },
  { id: "invites", label: "Invites" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Parse `?t=`: unknown tabs fall back to users. */
const toTabId = (raw: string): TabId =>
  TABS.find((tab) => tab.id === raw)?.id ?? "users";

/** Instance administration — admin role or NOITE_ADMIN_EMAIL only.
 * Everyone else bounces to /apps (server actions enforce the same gate).
 *
 * Same tab mechanism as the app detail page: the active tab lives in ?t= so a
 * refresh (or a shared link) restores it, and each tab fetches only its own
 * list. */
export default function GodMode() {
  head({ title: "God Mode · Noite" });
  const tab = searchParam<TabId>("t", { default: "users", parse: toTabId });
  const status = adminStatus();

  const overview = status.data();
  // Bounce non-admins once the check resolves; a failed check reads as
  // non-admin (server actions enforce the same gate).
  watch(status.data, () => {
    if (!status.loading() && !status.data()?.isAdmin) {
      navigate("/apps");
    }
  });
  // Skeleton only while cold: a cached admin check paints the panels at
  // once and revalidates in the background (the watch above bounces if the
  // fresh answer says otherwise).
  if (overview === undefined || !overview.isAdmin) {
    return <SessionSplash />;
  }
  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <div role="tablist" class="tabs tabs-border w-fit">
        {TABS.map((t) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab() === t.id ? "true" : "false"}
            class={`tab ${tab() === t.id ? "tab-active" : ""}`}
            onclick={() => {
              tab.set(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab() === "users" ? <AdminUsersPanel email={overview.email} /> : null}
      {tab() === "apps" ? <AdminAppsPanel /> : null}
      {tab() === "invites" ? <AdminInvitesPanel /> : null}
    </div>
  );
}
