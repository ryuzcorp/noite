//! Users tab of the control page (`/apps/_control?t=users`): every account —
//! search, page, ban, role, delete, impersonate.

import { useRouter } from "@ilha/void";
import { atom } from "ilha";
import type { View } from "ilha";

import { api } from "../api";
import type {
  AdminUserRow,
  EmailInviteView,
  EmailInviteWire,
} from "../api-types";
import { authClient } from "../auth-client";
import { rememberImpersonationReturn } from "../auth/impersonation";
import { invalidateSession } from "../auth/session";
import { errorMessage } from "../errors";
import { resourceValue, resourceError } from "../resource";
import { adminListEmailInvites, listUsers } from "../resources";
import { searchParam } from "../search-param";
import { Avatar } from "../ui/avatar";
import { confirmDialog } from "../ui/confirm";
import { CopyButton } from "../ui/copy-button";
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
  onApprove: (row: AdminUserRow) => void;
  onReject: (row: AdminUserRow) => void;
}

/** What one admin action is doing to one row. */
type RowAction =
  | "approve"
  | "ban"
  | "delete"
  | "impersonate"
  | "reject"
  | "role";

interface PendingAction {
  action: RowAction;
  id: string;
}

/** One badge tone per invite state. */
const INVITE_TONE: Record<EmailInviteWire, string> = {
  available: "badge-info",
  expired: "badge-warning",
  revoked: "badge-ghost",
  used: "badge-success",
};

/** The action buttons for one user row: nothing for the admin themself,
 * Approve/Reject for a waiting account, the full set otherwise. */
const rowActionsView = (props: AdminUserRowItemProps): View => {
  const { row } = props;

  if (row.self) {
    return null;
  }

  if (row.status === "pending") {
    return (
      <>
        <button
          type="button"
          class={`${ACTION} ${W_SM}`}
          disabled={props.pending !== null}
          onclick={() => {
            props.onApprove(row);
          }}
        >
          Approve
        </button>
        <button
          type="button"
          class={`${DANGER} ${W_SM}`}
          disabled={props.pending !== null}
          onclick={() => {
            props.onReject(row);
          }}
        >
          Reject
        </button>
      </>
    );
  }

  return (
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
  );
};

const AdminUserRowItem = (props: AdminUserRowItemProps) => {
  const { row } = props;

  return (
    <AdminRow
      avatar={<Avatar label={row.name || row.email} />}
      actions={rowActionsView(props)}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="truncate font-medium">{row.name || row.email}</span>
        {row.self ? <span class="badge badge-sm badge-ghost">you</span> : null}
        {row.status === "pending" ? (
          <span class="badge badge-sm badge-warning">waiting for approval</span>
        ) : null}
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

  const approveAccount = (user: AdminUserRow) =>
    mutate("approve", user.id, () =>
      api<{ ok: true }>("/api/admin/approveUser", user.id)
    );

  const rejectAccount = async (user: AdminUserRow) => {
    const ok = await confirmDialog({
      confirmLabel: "Reject",
      message:
        "Their account, sessions and API keys are removed. This cannot be undone.",
      title: `Reject ${user.email}?`,
    });

    if (ok !== "confirm") {
      return;
    }

    await mutate("reject", user.id, () =>
      api<{ ok: true }>("/api/admin/rejectUser", user.id)
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
            onApprove={(r) => {
              void approveAccount(r);
            }}
            onReject={(r) => {
              void rejectAccount(r);
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

/** Invite one address by email, and the outstanding invitations. The token
 * itself is shown once, at creation (and emailed when delivery is
 * configured) — the list never carries it again. */
interface InviteListInput {
  busy: boolean;
  created: boolean;
  invites: EmailInviteView[];
  loading: boolean;
  onRevoke: (id: string) => void;
  revokingId: string | null;
}

/** One row per outstanding invite, with Revoke on the live ones. */
const inviteRowsView = (input: InviteListInput): View => (
  <>
    {input.invites.map((row) => (
      <AdminRow
        key={row.id}
        avatar={<Avatar label={row.email} />}
        actions={
          row.state === "available" || row.state === "expired" ? (
            <button
              type="button"
              class={`${DANGER} ${W_SM}`}
              disabled={input.busy || input.revokingId !== null}
              onclick={() => {
                input.onRevoke(row.id);
              }}
            >
              Revoke
            </button>
          ) : null
        }
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="truncate font-medium">{row.email}</span>
          <span class={`badge badge-sm ${INVITE_TONE[row.state]}`}>
            {row.state}
          </span>
          {input.revokingId === row.id ? (
            <span class="text-xs opacity-70">revoking…</span>
          ) : null}
        </div>
        <div class="truncate text-xs opacity-70">
          invited by {row.createdByEmail || "—"} · expires{" "}
          {row.expiresAt || "—"}
          {row.usedByEmail ? ` · used by ${row.usedByEmail}` : ""}
        </div>
      </AdminRow>
    ))}
  </>
);

/** Skeleton while loading, the empty row when there is nothing to show, the
 * list otherwise. */
const inviteListView = (input: InviteListInput): View => {
  if (input.loading) {
    return <SkeletonRows />;
  }

  if (input.invites.length === 0 && !input.created) {
    return <li class={EMPTY_ROW}>No outstanding invitations.</li>;
  }

  return inviteRowsView(input);
};

const AdminInviteCard = () => {
  const res = adminListEmailInvites();
  const invites: EmailInviteView[] = resourceValue(res.state()) ?? [];
  const loadError = resourceError(res.state());
  const panelError = atom("");
  const busy = atom(false);
  const revoking = atom<string | null>(null);
  // Controlled input (house rules): the draft lives in an atom, the field
  // only renders it.
  const draft = atom("");
  const created = atom<{ emailed: boolean; link: string } | null>(null);

  const invite = async () => {
    const email = draft().trim();

    if (!email || busy()) {
      return;
    }

    busy.set(true);
    panelError.set("");

    try {
      const out = await api<{
        emailed: boolean;
        expiresAt: string;
        id: string;
        link: string;
      }>("/api/admin/adminCreateEmailInvite", { email });

      created.set({ emailed: out.emailed, link: out.link });
      draft.set("");
      await res.refetch();
    } catch (error) {
      panelError.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  const revoke = async (id: string) => {
    if (busy() || revoking() !== null) {
      return;
    }

    revoking.set(id);
    panelError.set("");

    try {
      await api<{ ok: true }>("/api/admin/adminRevokeEmailInvite", id);
      await res.refetch();
    } catch (error) {
      panelError.set(errorMessage(error));
    } finally {
      revoking.set(null);
    }
  };

  const loading = res.state()._tag === "Loading";

  return (
    <PanelCard
      title="Invite by email"
      note="An invitation is a single-use link, bound to the address and good for 7 days. Registration proves nothing by mailbox — the link is the proof."
      controls={
        <form
          class="flex items-center gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <label class="label sr-only" for="admin-invite-email">
            Email to invite
          </label>
          <input
            id="admin-invite-email"
            name="email"
            type="email"
            class="input input-sm w-56"
            placeholder="friend@example.com"
            autocomplete="off"
            value={draft()}
            oninput={(event) => {
              draft.set(
                event.currentTarget instanceof HTMLInputElement
                  ? event.currentTarget.value
                  : ""
              );
            }}
          />
          <button
            type="submit"
            class="btn btn-sm"
            disabled={busy() || !draft().trim()}
          >
            Invite
          </button>
        </form>
      }
    >
      <Problems load={loadError} panel={panelError()} />
      {created() ? (
        <AdminRow
          avatar={<Avatar label="✉" />}
          actions={
            <CopyButton
              class="btn btn-sm btn-ghost gap-1"
              label="Copy invite link"
              value={created()?.link ?? ""}
            />
          }
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="truncate font-medium">Invitation ready</span>
            <span class="badge badge-sm badge-success">one-time link</span>
          </div>
          <div class="truncate text-xs opacity-70">
            {created()?.emailed
              ? "Emailed, and copied from here."
              : "Copy it now — it is shown once."}{" "}
            <code class="font-mono">{created()?.link ?? ""}</code>
          </div>
        </AdminRow>
      ) : null}
      {inviteListView({
        busy: busy(),
        created: created() !== null,
        invites,
        loading,
        onRevoke: (id) => {
          void revoke(id);
        },
        revokingId: revoking(),
      })}
    </PanelCard>
  );
};

/** Every account: search, page, ban, role, delete, impersonate — plus the
 * waitlist (approve/reject on pending rows) and email invitations. The
 * search and page live in the URL (`?uq=`, `?up=`); a search is a server
 * query. */
export const AdminUsersPanel = () => {
  const query = searchParam("uq", { default: "" });
  const page = searchParam("up", { default: 0, parse: toPageIndex });

  return (
    <div class="flex flex-col gap-4">
      <AdminInviteCard />
      <PanelCard
        title="Users"
        note="Every account on this instance. Pending rows wait for approval: they hold no access until then."
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
    </div>
  );
};
