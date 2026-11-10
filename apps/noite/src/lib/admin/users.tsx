//! Admin tab: every account — search, page, ban, role, delete, impersonate.

import { useRouter } from "@ilha/void";
import { atom } from "ilha";
import type { View } from "ilha";

import { api } from "../api";
import type { AdminUserRow } from "../api-types";
import { authClient } from "../auth-client";
import { rememberImpersonationReturn } from "../auth/impersonation";
import { invalidateSession } from "../auth/session";
import { errorMessage } from "../errors";
import { resourceValue, resourceError } from "../resource";
import { listUsers } from "../resources";
import { searchParam } from "../search-param";
import { Avatar } from "../ui/avatar";
import { confirmDialog } from "../ui/confirm";
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
  toPageIndex,
} from "./shared";

interface AdminUserRowItemProps {
  row: AdminUserRow;
  /** The action running against this row, or null (per-row, not panel-wide:
   * one row's mutation no longer disables every other row's buttons). */
  pending: RowAction | null;
  onToggle: (row: AdminUserRow) => void;
  onImpersonate: (row: AdminUserRow) => void;
  onRole: (row: AdminUserRow) => void;
  onDelete: (row: AdminUserRow) => void;
}

/** What one admin action is doing to one row. */
type RowAction = "ban" | "delete" | "impersonate" | "role";

interface PendingAction {
  action: RowAction;
  id: string;
}

const AdminUserRowItem = (props: AdminUserRowItemProps) => {
  const { row } = props;

  return (
    <AdminRow
      avatar={<Avatar label={row.name || row.email} />}
      actions={
        row.self ? null : (
          <>
            <button
              type="button"
              class={`${ACTION} ${W_LG}`}
              disabled={props.pending !== null}
              onclick={() => {
                props.onImpersonate(row);
              }}
            >
              Impersonate
            </button>
            <button
              type="button"
              class={`${ACTION} ${W_LG}`}
              // A stored role outside {admin, user} cannot be reasoned about:
              // toggling it would rewrite a value nobody understands.
              disabled={props.pending !== null || !row.roleKnown}
              title={
                row.roleKnown
                  ? undefined
                  : "This account's stored role is not admin or user"
              }
              onclick={() => {
                props.onRole(row);
              }}
            >
              {row.role === "admin" ? "Remove admin" : "Make admin"}
            </button>
            <button
              type="button"
              class={`${ACTION} ${W_SM}`}
              disabled={props.pending !== null}
              onclick={() => {
                props.onToggle(row);
              }}
            >
              {row.banned ? "Unban" : "Ban"}
            </button>
            <button
              type="button"
              class={`${DANGER} ${W_SM}`}
              disabled={props.pending !== null}
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
        {row.self ? <span class="badge badge-sm badge-ghost">you</span> : null}
        {row.banned ? (
          <span class="badge badge-sm badge-error">banned</span>
        ) : null}
        {row.roleKnown ? null : (
          <span class="badge badge-sm badge-warning">unknown role</span>
        )}
      </div>
      <div class="truncate text-xs opacity-70">
        {row.email} · {row.role}
        {props.pending ? ` · ${props.pending}…` : ""}
      </div>
    </AdminRow>
  );
};

interface AdminUsersListProps {
  onPage: (page: number) => void;
  page: number;
  query: string;
}

/** The rows of one (query, page) of the user list, plus its pager. Keyed by
 * the parent on both, because a resource key cannot change under a mounted
 * component. The card around it (header, search) belongs to the parent, so a
 * new search or page swaps rows without remounting the input. */
const AdminUsersRows = ({ onPage, page, query }: AdminUsersListProps) => {
  const router = useRouter();
  const pending = atom<PendingAction | null>(null);
  const res = listUsers(query, page);
  const users = resourceValue(res.state())?.users ?? [];
  const hasMore = resourceValue(res.state())?.hasMore ?? false;
  const loadError = resourceError(res.state());
  const panelError = atom("");

  const reload = () => res.refetch();

  const impersonate = async (user: AdminUserRow) => {
    pending.set({ action: "impersonate", id: user.id });
    panelError.set("");

    try {
      const result = await authClient.admin.impersonateUser({
        userId: user.id,
      });

      if (result.error) {
        panelError.set(result.error.message ?? "Failed to impersonate user");

        return;
      }

      // The session cookie is swapped server-side. The layout stays
      // mounted across navigation, so drop every user-scoped cache —
      // otherwise the chrome keeps showing the admin's session.
      rememberImpersonationReturn();
      invalidateSession();
      router.visit("/apps");
    } catch (error) {
      panelError.set(errorMessage(error));
    } finally {
      pending.set(null);
    }
  };

  /** Run one admin mutation against one row, then reload this page. */
  const mutate = async <T,>(
    action: RowAction,
    id: string,
    work: () => Promise<T>
  ): Promise<void> => {
    pending.set({ action, id });
    panelError.set("");

    try {
      await work();
      await reload();
    } catch (error) {
      panelError.set(errorMessage(error));
    } finally {
      pending.set(null);
    }
  };

  const toggleBan = (user: AdminUserRow) =>
    mutate("ban", user.id, () =>
      user.banned
        ? api<{ ok: true }>("/api/admin/unbanUser", user.id)
        : api<{ ok: true }>("/api/admin/banUser", user.id)
    );

  const toggleRole = async (user: AdminUserRow) => {
    const next = user.role === "admin" ? "user" : "admin";

    const ok = await confirmDialog({
      confirmLabel: next === "admin" ? "Make admin" : "Remove admin",
      title: `Make ${user.email} ${next === "admin" ? "an admin" : "a regular user"}?`,
      tone: "neutral",
    });

    if (ok !== "confirm") {
      return;
    }

    await mutate("role", user.id, () =>
      api<{ ok: true }>("/api/admin/setUserRole", {
        role: next,
        userId: user.id,
      })
    );
  };

  const removeUser = async (user: AdminUserRow) => {
    const ok = await confirmDialog({
      confirmLabel: "Delete",
      message:
        "Their account, sessions and API keys are removed. This cannot be undone.",
      title: `Delete ${user.email}?`,
    });

    if (ok !== "confirm") {
      return;
    }

    await mutate("delete", user.id, () =>
      api<{ ok: true }>("/api/admin/deleteUser", user.id)
    );
  };

  const loading = res.state()._tag === "Loading";
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
            pending={
              pending()?.id === row.id ? (pending()?.action ?? null) : null
            }
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
export const AdminUsersPanel = () => {
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
        page={page()}
        query={query()}
        onPage={(next) => {
          page.set(next);
        }}
      />
    </PanelCard>
  );
};
