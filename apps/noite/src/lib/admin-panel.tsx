import { navigate } from "@ilha/router";
import { atom } from "ilha";

import {
  adminCreateInvites,
  adminRevokeInvite,
  banUser,
  unbanUser,
} from "./admin.server";
import { initials, presenceTone } from "./apps";
import { authClient } from "./auth-client";
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
        <div class="flex gap-1">
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
        </div>
      )}
    </li>
  );
};

const AdminAppRow = ({ row }: { row: AdminApp }) => (
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
      </div>
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

/** Every account, with ban / unban and impersonation. */
export const AdminUsersPanel = ({ email }: { email: string }) => {
  const busy = atom(false);
  const impersonating = atom(false);
  const res = listUsers();
  const users = res.data() ?? [];
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
      panelError.set(error instanceof Error ? error.message : String(error));
      impersonating.set(false);
    }
  };

  const toggleBan = async (user: AdminUser) => {
    busy.set(true);
    panelError.set("");
    try {
      await (user.banned ? unbanUser(user.id) : banUser(user.id));
      await reload();
    } catch (error) {
      panelError.set(error instanceof Error ? error.message : String(error));
    }
    busy.set(false);
  };

  if (res.loading() && res.data() === undefined) {
    return <PanelSkeleton title="Users" />;
  }
  return (
    <>
      {loadError ? (
        <p class="m-0 text-sm opacity-70">
          Failed to load: {String(loadError)}
        </p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="text-lg font-semibold tracking-wide">Users</span>
        </li>
        {panelError() ? (
          <li class="text-error px-4 pb-2 text-sm">{panelError()}</li>
        ) : null}
        {users.length === 0 ? (
          <li class="px-4 pt-2 pb-4 text-sm opacity-70">No users yet.</li>
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
            />
          ))
        )}
      </ul>
    </>
  );
};

/** Every app on the instance, whichever account owns it. */
export const AdminAppsPanel = () => {
  const res = listAllApps();
  const apps = res.data() ?? [];
  const loadError = res.error();

  if (res.loading() && res.data() === undefined) {
    return <PanelSkeleton title="Apps" />;
  }
  return (
    <>
      {loadError ? (
        <p class="m-0 text-sm opacity-70">
          Failed to load: {String(loadError)}
        </p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="text-lg font-semibold tracking-wide">Apps</span>
        </li>
        {apps.length === 0 ? (
          <li class="px-4 pt-2 pb-4 text-sm opacity-70">No apps yet.</li>
        ) : (
          apps.map((row) => <AdminAppRow key={row.id} row={row} />)
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
      panelError.set(error instanceof Error ? error.message : String(error));
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
      panelError.set(error instanceof Error ? error.message : String(error));
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
          Failed to load: {String(loadError)}
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
