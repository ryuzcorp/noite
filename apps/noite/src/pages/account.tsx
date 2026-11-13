import { AccountPanel } from "$lib/account/panel";
import { isInstanceAdmin } from "$lib/admin/access";
import { DetailShell } from "$lib/app-detail/shell";
import { CONTROL_APP_ID } from "$lib/control-app";
import { session } from "$lib/resources";
import { searchParam } from "$lib/search-param";
import { Avatar } from "$lib/ui/avatar";
import { useRouter } from "@ilha/void";
import { watch } from "ilha";

import { resourceValue } from "../lib/resource";

/** Shaped like an app's header: avatar, name, then one line of facts. The
 * role badge stays here (who you are); every admin *control* now lives on the
 * control page. */
const Header = ({ admin }: { admin: boolean }) => {
  const user = resourceValue(session().state())?.user;
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

/** `/account` is personal settings only: profile, passkeys, API keys, invite
 * codes and agent connect. Instance administration — users, apps, invites and
 * the instance switches (telemetry, release check) — is one place, the
 * control app's detail page (`/apps/_control`).
 *
 * The Admin tab that used to live here is gone; `?t=admin` was in docs, in the
 * update-notice e2e and in bookmarks, so it redirects to the control page's
 * Settings tab (the switches it used to hold) instead of landing on a tab
 * that no longer exists. A non-admin who follows such a link gets that page's
 * usual answer (the overview gate refuses it). */
export default function Account() {
  const router = useRouter();
  const tab = searchParam("t", { default: "" });

  watch.once(() => {
    if (typeof window === "undefined" || tab() !== "admin") {
      return;
    }

    void router.visit(`/apps/${CONTROL_APP_ID}?t=settings`);
  });

  const admin = isInstanceAdmin();

  return (
    <DetailShell panel={null} header={<Header admin={admin} />}>
      <AccountPanel />
    </DetailShell>
  );
}
