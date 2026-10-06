//! Admin tab: every account — search, page, ban, role, delete, impersonate.

import { navigate, searchParam } from "@ilha/router";
import { atom } from "ilha";
import type { View } from "ilha";

import { authClient } from "../auth-client";
import { invalidateSession } from "../auth/session";
import { errorMessage } from "../errors";
import { listUsers } from "../resources";
import {
  banUser,
  deleteUser,
  setUserRole,
  unbanUser,
} from "../server/admin.server";
import type { AdminUserRow } from "../server/admin.server";
import { Avatar } from "../ui/avatar";
import {
  ACTION,
  AdminRow,
  DANGER,
  EMPTY_ROW,
  PanelCard,
  Problems,
  SearchForm,
  SkeletonRows,
  W_LG,
  W_SM,
  confirmAction,
  toPageIndex,
} from "./shared";

interface AdminUserRowItemProps {
  row: AdminUserRow;
  isSelf: boolean;
  busy: boolean;
  impersonating: boolean;
  onToggle: (row: AdminUserRow) => void;
  onImpersonate: (row: AdminUserRow) => void;
  onRole: (row: AdminUserRow) => void;
  onDelete: (row: AdminUserRow) => void;
}

const AdminUserRowItem = (props: AdminUserRowItemProps) => {
  const { row } = props;
  return (
    <AdminRow
      avatar={<Avatar label={row.name || row.email} />}
      actions={
        props.isSelf ? null : (
          <>
            <button
              type="button"
              class={`${ACTION} ${W_LG}`}
              disabled={props.busy || props.impersonating}
              onclick={() => {
                props.onImpersonate(row);
              }}
            >
              Impersonate
            </button>
            <button
              type="button"
              class={`${ACTION} ${W_LG}`}
              disabled={props.busy}
              onclick={() => {
                props.onRole(row);
              }}
            >
              {row.role === "admin" ? "Remove admin" : "Make admin"}
            </button>
            <button
              type="button"
              class={`${ACTION} ${W_SM}`}
              disabled={props.busy}
              onclick={() => {
                props.onToggle(row);
              }}
            >
              {row.banned ? "Unban" : "Ban"}
            </button>
            <button
              type="button"
              class={`${DANGER} ${W_SM}`}
              disabled={props.busy}
              onclick={() => {
                props.onDelete(row);
              }}
            >
              Delete
            </button>
          </>
        )
      }
    >
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
    </AdminRow>
  );
};

interface AdminUsersListProps {
  email: string;
  onPage: (page: number) => void;
  page: number;
  query: string;
}

/** The rows of one (query, page) of the user list, plus its pager. Keyed by
 * the parent on both, because a resource key cannot change under a mounted
 * component. The card around it (header, search) belongs to the parent, so a
 * new search or page swaps rows without remounting the input. */
const AdminUsersRows = ({
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

  const impersonate = async (user: AdminUserRow) => {
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

  const toggleBan = (user: AdminUserRow) =>
    mutate(() => (user.banned ? unbanUser(user.id) : banUser(user.id)));

  const toggleRole = (user: AdminUserRow) => {
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

  const removeUser = (user: AdminUserRow) => {
    if (
      !confirmAction(
        `Delete ${user.email}? Their account, sessions and API keys are removed. This cannot be undone.`
      )
    ) {
      return Promise.resolve();
    }
    return mutate(() => deleteUser(user.id));
  };

  const loading = res.loading() && res.data() === undefined;
  let body: View;
  if (loading) {
    body = <SkeletonRows />;
  } else if (users.length === 0) {
    body = (
      <li class={EMPTY_ROW}>
        {query ? "No users match that search." : "No users yet."}
      </li>
    );
  } else {
    body = (
      <>
        {users.map((row) => (
          <AdminUserRowItem
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
        ))}
      </>
    );
  }
  return (
    <>
      <Problems load={loadError} panel={panelError()} />
      {body}
      <li class="flex items-center justify-end gap-2 p-4 pt-2">
        <button
          type="button"
          class={ACTION}
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
          class={ACTION}
          disabled={!hasMore}
          onclick={() => {
            onPage(page + 1);
          }}
        >
          Next
        </button>
      </li>
    </>
  );
};

/** Every account: search, page, ban, role, delete, impersonate. The search
 * and page live in the URL (`?uq=`, `?up=`); a search is a server query. */
export const AdminUsersPanel = ({ email }: { email: string }) => {
  const query = searchParam("uq", { default: "" });
  const page = searchParam("up", { default: 0, parse: toPageIndex });

  return (
    <PanelCard
      title="Users"
      note="Every account on this instance."
      controls={
        <SearchForm
          id="admin-user-search"
          label="Search users by email or name"
          placeholder="Search by email or name"
          value={query()}
          onSearch={(value) => {
            query.set(value);
            page.set(0);
          }}
        />
      }
    >
      <AdminUsersRows
        key={`${query()}:${page()}`}
        email={email}
        page={page()}
        query={query()}
        onPage={(next) => {
          page.set(next);
        }}
      />
    </PanelCard>
  );
};
