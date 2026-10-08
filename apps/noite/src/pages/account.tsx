import { isInstanceAdmin, TelemetryCard } from "$lib/account/admin-telemetry";
import { AccountPanel } from "$lib/account/panel";
import { DetailShell, DetailTabs } from "$lib/app-detail/shell";
import { CONTROL_APP_ID, CONTROL_APP_NAME } from "$lib/control-app";
import { session } from "$lib/resources";
import { searchParam } from "$lib/search-param";
import { Avatar } from "$lib/ui/avatar";
import { head } from "@ilha/router";

const TABS = [
  { id: "account", label: "Account" },
  { id: "admin", label: "Admin" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Parse `?t=`: unknown tabs fall back to account. */
const toTabId = (raw: string): TabId =>
  TABS.find((tab) => tab.id === raw)?.id ?? "account";

/** Shaped like an app's header: avatar, name, then one line of facts. */
const Header = ({ admin }: { admin: boolean }) => {
  const user = session().data()?.user;
  const name = user?.name || user?.email || "Account";
  return (
    <header class="flex min-w-0 items-center gap-3">
      <Avatar class="shrink-0" label={name} size="lg" />
      <div class="min-w-0">
        <h1 class="m-0 truncate text-xl font-semibold">{name}</h1>
        <p class="m-0 flex flex-wrap items-center gap-x-2 text-sm">
          <span class="opacity-70">{user?.email ?? ""}</span>
          {admin ? <span class="badge badge-sm">admin</span> : null}
        </p>
      </div>
    </header>
  );
};

/** Where the rest of instance administration lives. */
const AdminHomeCard = () => (
  <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-2 border p-4 shadow-md">
    <h2 class="m-0 text-lg font-semibold">Users, apps and invites</h2>
    <p class="m-0 text-sm opacity-80">
      Managed on the{" "}
      <a class="link" href={`/apps/${CONTROL_APP_ID}?t=users`}>
        {CONTROL_APP_NAME} admin page
      </a>
      .
    </p>
  </section>
);

export default function Account() {
  head({ title: "Account · Noite" });
  const tab = searchParam<TabId>("t", { default: "account", parse: toTabId });
  const admin = isInstanceAdmin();
  // The Admin tab exists for a real instance admin only; a stale `?t=admin`
  // for anyone else lands on Account.
  const active: TabId = admin ? tab() : "account";

  return (
    <DetailShell
      panel={null}
      header={
        <>
          <Header admin={admin} />
          <DetailTabs
            active={active}
            tabs={admin ? TABS : TABS.filter((item) => item.id !== "admin")}
            onSelect={(next) => {
              tab.set(toTabId(next));
            }}
          />
        </>
      }
    >
      {active === "account" ? <AccountPanel /> : null}
      {active === "admin" ? (
        <>
          <TelemetryCard />
          <AdminHomeCard />
        </>
      ) : null}
    </DetailShell>
  );
}
