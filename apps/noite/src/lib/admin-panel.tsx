import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";

import { banUser, listAllApps, listUsers, unbanUser } from "./admin.server";
import { authClient } from "./auth-client";
import { ListSkeleton, SectionSkeleton } from "./skeletons";

interface AdminUser {
  banned: boolean;
  createdAt: string;
  email: string;
  id: string;
  name: string;
  role: string;
}

interface AdminApp {
  desiredState: string;
  id: string;
  name: string;
  ownerId: string;
  slug: string;
  status: string;
}

interface AdminUserRowProps {
  key?: string;
  row: AdminUser;
  isSelf: boolean;
  busy: boolean;
  impersonating: boolean;
  onToggle: (row: AdminUser) => void;
  onImpersonate: (row: AdminUser) => void;
}

const AdminUserRow = (props: AdminUserRowProps) => {
  const { row } = props;
  return (
    <li class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
      <div class="flex flex-col gap-0.5">
        <span class="font-medium">
          {row.name || row.email}
          {props.isSelf ? " (you)" : ""}
        </span>
        <span class="text-xs opacity-70">
          {row.email} · {row.role}
          {row.banned ? " · banned" : ""}
        </span>
      </div>
      {props.isSelf ? null : (
        <span class="flex gap-1">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={props.busy || props.impersonating}
            onclick={() => {
              props.onImpersonate(row);
            }}
          >
            Impersonate
          </button>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={props.busy}
            onclick={() => {
              props.onToggle(row);
            }}
          >
            {row.banned ? "Unban" : "Ban"}
          </button>
        </span>
      )}
    </li>
  );
};

interface AdminUserListProps {
  busy: boolean;
  impersonating: boolean;
  selfEmail: string;
  users: AdminUser[];
  onToggle: (row: AdminUser) => void;
  onImpersonate: (row: AdminUser) => void;
}

const AdminUserList = (props: AdminUserListProps) => {
  if (props.users.length === 0) {
    return <p class="m-0 text-sm opacity-70">No users yet.</p>;
  }
  return (
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
      {props.users.map((row) => (
        <AdminUserRow
          key={row.id}
          row={row}
          isSelf={row.email === props.selfEmail}
          busy={props.busy}
          impersonating={props.impersonating}
          onToggle={props.onToggle}
          onImpersonate={props.onImpersonate}
        />
      ))}
    </ul>
  );
};

const AdminAppList = (props: { apps: AdminApp[] }) => {
  if (props.apps.length === 0) {
    return <p class="m-0 text-sm opacity-70">No apps yet.</p>;
  }
  return (
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
      {props.apps.map((row) => (
        <li
          key={row.id}
          class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
        >
          <div class="flex flex-col gap-0.5">
            <span class="font-medium">
              <a class="link link-hover" href={`/apps/${row.id}`}>
                {row.name}
              </a>{" "}
              · <code>{row.slug}</code>
            </span>
            <span class="text-xs opacity-70">
              {row.status}
              {row.desiredState && row.desiredState !== row.status
                ? ` → ${row.desiredState}`
                : ""}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
};

/** Instance administration (admin role or NOITE_ADMIN_EMAIL): every user
 * and every app, with ban / unban. Rendered only behind the god-mode
 * route gate — never for anyone else. Takes the gate result as a prop so
 * the page performs the admin check exactly once. */
export const AdminPanel = ({ email }: { email: string }) => {
  const busy = atom(false);
  const impersonating = atom(false);
  const loadError = atom("");
  const loading = atom(true);
  const adminError = atom("");
  const users = atom<AdminUser[]>([]);
  const apps = atom<AdminApp[]>([]);

  const reload = async () => {
    const [userRows, appRows] = await Promise.all([listUsers(), listAllApps()]);
    users.set(userRows ?? []);
    apps.set(appRows ?? []);
  };

  watch.once(() => {
    void (async () => {
      try {
        await reload();
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
      loading.set(false);
    })();
  });

  const impersonate = async (user: AdminUser) => {
    impersonating.set(true);
    adminError.set("");
    try {
      const result = await authClient.admin.impersonateUser({
        userId: user.id,
      });
      if (result.error) {
        adminError.set(result.error.message ?? "Failed to impersonate user");
        impersonating.set(false);
        return;
      }
      // SPA nav: the session cookie is swapped server-side; the gate
      // re-reads it on the next mount with no document reload.
      navigate("/apps");
    } catch (error) {
      adminError.set(error instanceof Error ? error.message : String(error));
      impersonating.set(false);
    }
  };

  const toggleBan = async (user: AdminUser) => {
    busy.set(true);
    adminError.set("");
    try {
      await (user.banned ? unbanUser(user.id) : banUser(user.id));
      await reload();
    } catch (error) {
      adminError.set(error instanceof Error ? error.message : String(error));
    }
    busy.set(false);
  };

  if (loading()) {
    return (
      <div class="flex flex-col gap-3">
        <SectionSkeleton lines={2} />
        <ListSkeleton rows={3} />
      </div>
    );
  }
  if (loadError()) {
    return <p class="m-0 text-sm opacity-70">Failed to load: {loadError()}</p>;
  }
  return (
    <section class="border-base-300 flex flex-col gap-3 rounded-lg border p-4">
      <h2 class="m-0 text-lg font-semibold">Administration</h2>
      {adminError() ? (
        <p class="text-error m-0 text-sm">{adminError()}</p>
      ) : null}
      <AdminUserList
        busy={busy()}
        impersonating={impersonating()}
        selfEmail={email}
        users={users()}
        onToggle={(row) => {
          void toggleBan(row);
        }}
        onImpersonate={(row) => {
          void impersonate(row);
        }}
      />
      <AdminAppList apps={apps()} />
    </section>
  );
};
