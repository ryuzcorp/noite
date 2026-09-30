import { navigate, searchParam } from "@ilha/router";
import { atom } from "ilha";

import {
  adminCreateInvites,
  adminDeleteApp,
  adminRevokeInvite,
  adminSetAppState,
  banUser,
  deleteUser,
  setUserRole,
  unbanUser,
} from "./admin.server";
import { initials, presenceTone } from "./apps";
import { authClient } from "./auth-client";
import { errorMessage } from "./errors";
import { adminListInvites, listAllApps, listUsers } from "./resources";
import { invalidateSession } from "./session";

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
  ownerEmail: string;
  ownerId: string;
  slug: string;
  status: string;
}

interface AdminUserRowProps {
  row: AdminUser;
  isSelf: boolean;
  busy: boolean;
  impersonating: boolean;
  onToggle: (row: AdminUser) => void;
  onImpersonate: (row: AdminUser) => void;
  onRole: (row: AdminUser) => void;
  onDelete: (row: AdminUser) => void;
}

const AdminUserRow = (props: AdminUserRowProps) => {
  const { row } = props;
  return (
    <li class="list-row">
      <div>
        <div class="avatar avatar-placeholder">
          <div class="bg-neutral text-neutral-content w-10 rounded-full">
            <span class="text-sm">{initials(row.name || row.email)}</span>
          </div>
        </div>
      </div>
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="truncate font-medium">{row.name || row.email}</span>
          {props.isSelf ? (
            <span class="badge badge-sm badge-ghost">you</span>
          ) : null}
          {row.banned ? (
            <span class="badge badge-sm badge-error">banned</span>
          ) : null}
        </div>
        <div class="truncate text-xs opacity-70">
          {row.email} · {row.role}
        </div>
      </div>
      {props.isSelf ? null : (
        <div class="flex flex-wrap justify-end gap-1">
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
              props.onRole(row);
            }}
          >
            {row.role === "admin" ? "Remove admin" : "Make admin"}
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
          <button
            type="button"
            class="btn btn-sm btn-ghost text-error"
            disabled={props.busy}
            onclick={() => {
              props.onDelete(row);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
};

interface AdminAppRowProps {
  busy: boolean;
  onDelete: (row: AdminApp) => void;
  onToggle: (row: AdminApp) => void;
  row: AdminApp;
}

const AdminAppRow = ({ busy, onDelete, onToggle, row }: AdminAppRowProps) => (
  <li class="list-row">
    <div>
      <div class="avatar avatar-placeholder">
        <div class="bg-neutral text-neutral-content w-10 rounded-full">
          <span class="text-sm">{initials(row.name)}</span>
        </div>
        <span
          class={`status ${presenceTone(row.status)} absolute right-0 bottom-0`}
          title={row.status}
        />
      </div>
    </div>
    <div class="min-w-0">
      <a
        href={`/apps/${row.id}`}
        class="link link-hover block truncate font-medium"
      >
        {row.name}
      </a>
      <div class="truncate text-xs opacity-70">
        <code>{row.slug}</code>
        {" · "}
        {row.status}
        {row.desiredState && row.desiredState !== row.status
          ? ` → ${row.desiredState}`
          : ""}
        {row.ownerEmail ? ` · ${row.ownerEmail}` : ""}
      </div>
    </div>
    <div class="flex gap-1">
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        disabled={busy}
        onclick={() => {
          onToggle(row);
        }}
      >
        {row.desiredState === "running" ? "Stop" : "Start"}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-ghost text-error"
        disabled={busy}
        onclick={() => {
          onDelete(row);
        }}
      >
        Delete
      </button>
    </div>
  </li>
);

interface AdminInvite {
  code: string;
  createdAt: string;
  createdByEmail: string;
  id: string;
  revoked: boolean;
  usedAt: string;
  usedByEmail: string;
}

const inviteState = (row: AdminInvite): string => {
  if (row.usedByEmail) {
    return `used by ${row.usedByEmail}`;
  }
  return row.revoked ? "revoked" : "available";
};

const InviteRow = (props: {
  busy: boolean;
  copied: string;
  inv: AdminInvite;
  onCopy: (code: string) => void;
  onRevoke: (id: string) => void;
}) => {
  const { inv } = props;
  const open = !(inv.usedByEmail || inv.revoked);
  return (
    <li class="list-row">
      {/* Two children: without `list-col-grow` the actions column would take
          the `1fr` and the buttons would float mid-row. */}
      <div class="list-col-grow min-w-0">
        <code class="font-mono text-xs">
          {props.copied === inv.code ? "copied" : inv.code}
        </code>
        <div class="truncate text-xs opacity-70">
          {inviteState(inv)} · from {inv.createdByEmail}
        </div>
      </div>
      <div class="flex gap-1">
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onclick={() => {
            props.onCopy(inv.code);
          }}
        >
          Copy
        </button>
        {open ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={props.busy}
            onclick={() => {
              props.onRevoke(inv.id);
            }}
          >
            Revoke
          </button>
        ) : null}
      </div>
    </li>
  );
};

/** Each tab is one daisyUI list, and the list *is* the card (the same shape as
 * the apps list): a `list-row` carries `padding: 1rem` itself, so putting one
 * inside a `card-body` padded the rows twice and shifted them off the header.
 * The header is a plain `li` (no `list-row`, so no divider). */
const PanelSkeleton = ({ title }: { title: string }) => (
  <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
    <li class="flex items-center justify-between gap-2 p-4 pb-2">
      <span class="text-lg font-semibold tracking-wide">{title}</span>
    </li>
    {Array.from({ length: 3 }, (_, i) => (
      <li key={i} class="list-row">
        <div>
          <div class="skeleton size-10 shrink-0 rounded-full" />
        </div>
        <div class="flex flex-col gap-1">
          <div class="skeleton h-4 w-40" />
          <div class="skeleton h-3 w-24" />
        </div>
      </li>
    ))}
  </ul>
);

/** One tab per subject, and each tab loads only its own list: the panels are
 * independent (mirroring the app-detail tabs), so opening Users never waits on
 * the invite or app queries and an admin save reloads a single list.
 *
 * All three are rendered only behind the god-mode route gate — the server
 * actions enforce the same check — and the gate result arrives as a prop so
 * the page performs it exactly once. */

/** Native confirm dialog: the requirement for privilege changes and
 * destructive deletes. */
const confirmAction = (message: string): boolean =>
  // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive admin actions.
  window.confirm(message);

/** Parse `?up=` (page index): garbage falls back to the first page. */
const toPageIndex = (raw: string): number =>
  Math.max(Math.trunc(Number(raw)) || 0, 0);

interface AdminUsersListProps {
  email: string;
  onPage: (page: number) => void;
  page: number;
  query: string;
}

/** One (query, page) of the user list. Keyed by the parent on both, because a
 * resource key cannot change under a mounted component. */
const AdminUsersList = ({
  email,
  onPage,
  page,
  query,
}: AdminUsersListProps) => {
  const busy = atom(false);
  const impersonating = atom(false);
  const res = listUsers(query, page);
  const users = res.data()?.users ?? [];
  const hasMore = res.data()?.hasMore ?? false;
  const loadError = res.error();
  const panelError = atom("");

  const reload = () => res.refetch();

  const impersonate = async (user: AdminUser) => {
    impersonating.set(true);
    panelError.set("");
    try {
      const result = await authClient.admin.impersonateUser({
        userId: user.id,
      });
      if (result.error) {
        panelError.set(result.error.message ?? "Failed to impersonate user");
        impersonating.set(false);
        return;
      }
      // The session cookie is swapped server-side. The layout stays
      // mounted across navigation, so drop every user-scoped cache —
      // otherwise the chrome keeps showing the admin's session.
      invalidateSession();
      navigate("/apps");
    } catch (error) {
      panelError.set(errorMessage(error));
      impersonating.set(false);
    }
  };

  /** Run one admin mutation, then reload this page of the list. */
  const mutate = async <T,>(work: () => Promise<T>): Promise<void> => {
    busy.set(true);
    panelError.set("");
    try {
      await work();
      await reload();
    } catch (error) {
      panelError.set(errorMessage(error));
    }
    busy.set(false);
  };

  const toggleBan = (user: AdminUser) =>
    mutate(() => (user.banned ? unbanUser(user.id) : banUser(user.id)));

  const toggleRole = (user: AdminUser) => {
    const next = user.role === "admin" ? "user" : "admin";
    if (
      !confirmAction(
        `Make ${user.email} ${next === "admin" ? "an admin" : "a regular user"}?`
      )
    ) {
      return Promise.resolve();
    }
    return mutate(() => setUserRole({ role: next, userId: user.id }));
  };

  const removeUser = (user: AdminUser) => {
    if (
      !confirmAction(
        `Delete ${user.email}? Their account, sessions and API keys are removed. This cannot be undone.`
      )
    ) {
      return Promise.resolve();
    }
    return mutate(() => deleteUser(user.id));
  };

  if (res.loading() && res.data() === undefined) {
    return <PanelSkeleton title="Users" />;
  }
  return (
    <>
      {loadError ? (
        <p class="m-0 text-sm opacity-70">
          Failed to load: {errorMessage(loadError)}
        </p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="text-lg font-semibold tracking-wide">Users</span>
          <span class="flex items-center gap-2">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={page === 0}
              onclick={() => {
                onPage(page - 1);
              }}
            >
              Previous
            </button>
            <span class="text-xs opacity-70">Page {page + 1}</span>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={!hasMore}
              onclick={() => {
                onPage(page + 1);
              }}
            >
              Next
            </button>
          </span>
        </li>
        {panelError() ? (
          <li class="text-error px-4 pb-2 text-sm">{panelError()}</li>
        ) : null}
        {users.length === 0 ? (
          <li class="px-4 pt-2 pb-4 text-sm opacity-70">
            {query ? "No users match that search." : "No users yet."}
          </li>
        ) : (
          users.map((row) => (
            <AdminUserRow
              key={row.id}
              row={row}
              isSelf={row.email === email}
              busy={busy()}
              impersonating={impersonating()}
              onToggle={(r) => {
                void toggleBan(r);
              }}
              onImpersonate={(r) => {
                void impersonate(r);
              }}
              onRole={(r) => {
                void toggleRole(r);
              }}
              onDelete={(r) => {
                void removeUser(r);
              }}
            />
          ))
        )}
      </ul>
    </>
  );
};

/** Every account: search, page, ban, role, delete, impersonate. The search
 * and page live in the URL (`?uq=`, `?up=`) like the app tabs' filters, so a
 * refresh or shared link restores them; the search applies on submit rather
 * than per keystroke, so typing never fires a query. */
export const AdminUsersPanel = ({ email }: { email: string }) => {
  const query = searchParam("uq", { default: "" });
  const page = searchParam("up", { default: 0, parse: toPageIndex });
  const draft = atom(query());

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    query.set(draft().trim());
    page.set(0);
  };

  return (
    <>
      <form class="flex items-center gap-2" onsubmit={submit} role="search">
        <input
          id="admin-user-search"
          class="input input-sm w-64"
          type="search"
          placeholder="Search by email or name"
          aria-label="Search users by email or name"
          value={draft()}
          oninput={(e) => {
            draft.set(e.currentTarget.value);
          }}
        />
        <button type="submit" class="btn btn-sm">
          Search
        </button>
      </form>
      <AdminUsersList
        key={`${query()}:${page()}`}
        email={email}
        page={page()}
        query={query()}
        onPage={(next) => {
          page.set(next);
        }}
      />
    </>
  );
};

/** Every app on the instance, whichever account owns it: filter by name,
 * slug or owner; start, stop or delete any of them. */
export const AdminAppsPanel = () => {
  const res = listAllApps();
  const filter = atom("");
  const busy = atom(false);
  const panelError = atom("");
  const apps = res.data() ?? [];
  const loadError = res.error();
  const needle = filter().trim().toLowerCase();
  const shown = needle
    ? apps.filter((app) =>
        [app.name, app.slug, app.ownerEmail].some((field) =>
          field.toLowerCase().includes(needle)
        )
      )
    : apps;

  const mutate = async <T,>(work: () => Promise<T>): Promise<void> => {
    busy.set(true);
    panelError.set("");
    try {
      await work();
      await res.refetch();
    } catch (error) {
      panelError.set(errorMessage(error));
    }
    busy.set(false);
  };

  if (res.loading() && res.data() === undefined) {
    return <PanelSkeleton title="Apps" />;
  }
  return (
    <>
      {loadError ? (
        <p class="m-0 text-sm opacity-70">
          Failed to load: {errorMessage(loadError)}
        </p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="text-lg font-semibold tracking-wide">Apps</span>
          <input
            id="admin-app-filter"
            class="input input-sm w-56"
            type="search"
            placeholder="Filter by name, slug or owner"
            aria-label="Filter apps by name, slug or owner"
            value={filter()}
            oninput={(e) => {
              filter.set(e.currentTarget.value);
            }}
          />
        </li>
        {panelError() ? (
          <li class="text-error px-4 pb-2 text-sm">{panelError()}</li>
        ) : null}
        {shown.length === 0 ? (
          <li class="px-4 pt-2 pb-4 text-sm opacity-70">
            {needle ? "No apps match that filter." : "No apps yet."}
          </li>
        ) : (
          shown.map((row) => (
            <AdminAppRow
              key={row.id}
              row={row}
              busy={busy()}
              onToggle={(app) => {
                void mutate(() =>
                  adminSetAppState({
                    desiredState:
                      app.desiredState === "running" ? "stopped" : "running",
                    id: app.id,
                  })
                );
              }}
              onDelete={(app) => {
                if (
                  !confirmAction(
                    `Delete ${app.name} (${app.slug})? This removes the app, its git remote and its fleet.`
                  )
                ) {
                  return;
                }
                void mutate(() => adminDeleteApp(app.id));
              }}
            />
          ))
        )}
      </ul>
    </>
  );
};

/** The invite pool: mint codes, hand them out, revoke what is still open. */
export const AdminInvitesPanel = () => {
  const busy = atom(false);
  const res = adminListInvites();
  const invites = res.data() ?? [];
  const loadError = res.error();
  const panelError = atom("");
  const mintCount = atom(3);
  const copied = atom("");

  const reload = () => res.refetch();

  const mint = async () => {
    busy.set(true);
    panelError.set("");
    try {
      await adminCreateInvites({ count: Number(mintCount()) });
      await reload();
    } catch (error) {
      panelError.set(errorMessage(error));
    }
    busy.set(false);
  };

  const revoke = async (id: string) => {
    busy.set(true);
    panelError.set("");
    try {
      await adminRevokeInvite(id);
      await reload();
    } catch (error) {
      panelError.set(errorMessage(error));
    }
    busy.set(false);
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      copied.set(code);
      setTimeout(() => {
        copied.set("");
      }, 1500);
    } catch {
      // Clipboard permission denied (or insecure context): leave the code
      // visible so the operator can select it by hand.
      copied.set("");
    }
  };

  if (res.loading() && res.data() === undefined) {
    return <PanelSkeleton title="Invites" />;
  }
  return (
    <>
      {loadError ? (
        <p class="m-0 text-sm opacity-70">
          Failed to load: {errorMessage(loadError)}
        </p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="text-lg font-semibold tracking-wide">Invites</span>
          <span class="flex items-center gap-2">
            <label class="label text-xs opacity-70" for="invite-count">
              codes
            </label>
            <input
              id="invite-count"
              type="number"
              min="1"
              max="50"
              class="input input-sm w-20"
              value={mintCount()}
              oninput={(e) => {
                mintCount.set(Number(e.currentTarget.value));
              }}
            />
            <button
              type="button"
              class="btn btn-sm"
              disabled={busy()}
              onclick={() => {
                void mint();
              }}
            >
              Generate
            </button>
          </span>
        </li>
        <li class="px-4 pb-2 text-xs opacity-70">
          Registration is invite-only. Every new account receives 2 codes of its
          own to hand out.
        </li>
        {panelError() ? (
          <li class="text-error px-4 pb-2 text-sm">{panelError()}</li>
        ) : null}
        {invites.length === 0 ? (
          <li class="px-4 pt-2 pb-4 text-sm opacity-70">No codes yet.</li>
        ) : (
          invites.map((inv) => (
            <InviteRow
              key={inv.id}
              inv={inv}
              busy={busy()}
              copied={copied()}
              onCopy={(code) => {
                void copy(code);
              }}
              onRevoke={(id) => {
                void revoke(id);
              }}
            />
          ))
        )}
      </ul>
    </>
  );
};
