import { navigate, searchParam } from "@ilha/router";
import { atom } from "ilha";
import type { View } from "ilha";

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

/** The three tabs share one layout so switching between them moves nothing:
 * the same card (header, note, rows), the same control sizes, and the same
 * action column. Anything a tab adds goes into a slot of it, never around it. */

/** Header inputs and buttons. `btn` (solid) is the tab's one primary action;
 * every row action and the pager is `ACTION`. */
const FIELD = "input input-sm w-56";
const PRIMARY = "btn btn-sm";
const ACTION = "btn btn-sm btn-ghost";
const DANGER = `${ACTION} text-error`;
/** Row actions are right-aligned and fixed-width, so a label that flips
 * (Stop/Start, Ban/Unban, Make/Remove admin) or a button that is absent
 * (Revoke on a used code) never shifts its neighbours. */
const W_SM = "min-w-20";
const W_LG = "min-w-28";
const ACTIONS = "flex flex-wrap items-center justify-end gap-1";
const NOTE_ROW = "px-4 pb-2 text-xs opacity-70";
const ERROR_ROW = "text-error px-4 pb-2 text-sm";
const EMPTY_ROW = "px-4 pt-2 pb-4 text-sm opacity-70";
const SKELETON_ROWS = 3;

/** Each tab is one daisyUI list, and the list *is* the card (the same shape as
 * the apps list): a `list-row` carries `padding: 1rem` itself, so putting one
 * inside a `card-body` padded the rows twice and shifted them off the header.
 * The header and note are plain `li`s (no `list-row`, so no divider), and the
 * header has a fixed height so a tab with no controls does not sit shorter. */
const PanelCard = ({
  children,
  controls,
  note,
  title,
}: {
  children: View;
  controls?: View;
  note: string;
  title: string;
}) => (
  <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
    <li class="flex min-h-14 flex-wrap items-center justify-between gap-2 p-4 pb-2">
      <span class="text-lg font-semibold tracking-wide">{title}</span>
      <span class="flex items-center gap-2">{controls}</span>
    </li>
    <li class={NOTE_ROW}>{note}</li>
    {children}
  </ul>
);

/** Rows while a list loads: the real row shape, so the card keeps its height
 * and the header and controls above stay put. */
const SkeletonRows = () => (
  <>
    {Array.from({ length: SKELETON_ROWS }, (_, i) => (
      <li key={i} class="list-row items-center">
        <div>
          <div class="skeleton size-10 shrink-0 rounded-full" />
        </div>
        <div class="list-col-grow flex flex-col gap-1">
          <div class="skeleton h-4 w-40" />
          <div class="skeleton h-3 w-24" />
        </div>
        <div class={ACTIONS} />
      </li>
    ))}
  </>
);

/** Load and mutation failures, as rows inside the card (a paragraph above it
 * would push the card down). */
const Problems = ({ load, panel }: { load: unknown; panel: string }) => (
  <>
    {load ? (
      <li class={ERROR_ROW}>Failed to load: {errorMessage(load)}</li>
    ) : null}
    {panel ? <li class={ERROR_ROW}>{panel}</li> : null}
  </>
);

/** The header's search, identical on every tab: an input and a Search button,
 * applied on submit (never per keystroke) and kept in the URL by the caller, so
 * a refresh, a shared link or a trip through another tab restores it. Submitting
 * an empty box clears the search. */
const SearchForm = ({
  id,
  label,
  onSearch,
  placeholder,
  value,
}: {
  id: string;
  label: string;
  onSearch: (value: string) => void;
  placeholder: string;
  value: string;
}) => {
  const draft = atom(value);
  return (
    <form
      class="flex items-center gap-2"
      role="search"
      onsubmit={(event: SubmitEvent) => {
        event.preventDefault();
        onSearch(draft().trim());
      }}
    >
      <input
        id={id}
        class={FIELD}
        type="search"
        placeholder={placeholder}
        aria-label={label}
        value={draft()}
        oninput={(e) => {
          draft.set(e.currentTarget.value);
        }}
      />
      <button type="submit" class={PRIMARY}>
        Search
      </button>
    </form>
  );
};

/** Leading avatar of every row: initials, plus a status dot when the subject
 * has a state worth a glance. */
const RowAvatar = ({
  label,
  status,
  tone,
}: {
  label: string;
  status?: string;
  tone?: string;
}) => (
  <div class="avatar avatar-placeholder">
    <div class="bg-neutral text-neutral-content w-10 rounded-full">
      <span class="text-sm">{initials(label)}</span>
    </div>
    {tone ? (
      <span class={`status ${tone} absolute right-0 bottom-0`} title={status} />
    ) : null}
  </div>
);

/** One row: avatar, a growing text column, and the actions. */
const AdminRow = ({
  actions,
  avatar,
  children,
}: {
  actions?: View;
  avatar: View;
  children: View;
}) => (
  <li class="list-row items-center">
    <div>{avatar}</div>
    <div class="list-col-grow min-w-0">{children}</div>
    <div class={ACTIONS}>{actions}</div>
  </li>
);

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
    <AdminRow
      avatar={<RowAvatar label={row.name || row.email} />}
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

interface AdminAppRowProps {
  busy: boolean;
  onDelete: (row: AdminApp) => void;
  onToggle: (row: AdminApp) => void;
  row: AdminApp;
}

const AdminAppRow = ({ busy, onDelete, onToggle, row }: AdminAppRowProps) => (
  <AdminRow
    avatar={
      <RowAvatar
        label={row.name}
        status={row.status}
        tone={presenceTone(row.status)}
      />
    }
    actions={
      <>
        <button
          type="button"
          class={`${ACTION} ${W_SM}`}
          disabled={busy}
          onclick={() => {
            onToggle(row);
          }}
        >
          {row.desiredState === "running" ? "Stop" : "Start"}
        </button>
        <button
          type="button"
          class={`${DANGER} ${W_SM}`}
          disabled={busy}
          onclick={() => {
            onDelete(row);
          }}
        >
          Delete
        </button>
      </>
    }
  >
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
  </AdminRow>
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

const inviteTone = (row: AdminInvite): string => {
  if (row.usedByEmail) {
    return "status-neutral";
  }
  return row.revoked ? "status-error" : "status-success";
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
    <AdminRow
      avatar={
        <RowAvatar
          label={inv.createdByEmail || inv.code}
          status={inviteState(inv)}
          tone={inviteTone(inv)}
        />
      }
      actions={
        <>
          <button
            type="button"
            class={`${ACTION} ${W_SM}`}
            onclick={() => {
              props.onCopy(inv.code);
            }}
          >
            Copy
          </button>
          {/* Always rendered, hidden once the code is spent: Copy keeps its
              place instead of sliding right on those rows. */}
          <button
            type="button"
            class={`${DANGER} ${W_SM} ${open ? "" : "invisible"}`}
            disabled={props.busy || !open}
            aria-hidden={open ? "false" : "true"}
            tabindex={open ? 0 : -1}
            onclick={() => {
              props.onRevoke(inv.id);
            }}
          >
            Revoke
          </button>
        </>
      }
    >
      <code class="font-mono text-sm">
        {props.copied === inv.code ? "copied" : inv.code}
      </code>
      <div class="truncate text-xs opacity-70">
        {inviteState(inv)} · from {inv.createdByEmail}
      </div>
    </AdminRow>
  );
};

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

/** Every app on the instance, whichever account owns it: filter by name,
 * slug or owner; start, stop or delete any of them. The search lives in the
 * URL (`?aq=`) and narrows the loaded list in the browser. */
export const AdminAppsPanel = () => {
  const res = listAllApps();
  const search = searchParam("aq", { default: "" });
  const busy = atom(false);
  const panelError = atom("");
  const apps = res.data() ?? [];
  const loadError = res.error();
  const needle = search().trim().toLowerCase();
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

  const loading = res.loading() && res.data() === undefined;
  let body: View;
  if (loading) {
    body = <SkeletonRows />;
  } else if (shown.length === 0) {
    body = (
      <li class={EMPTY_ROW}>
        {needle ? "No apps match that search." : "No apps yet."}
      </li>
    );
  } else {
    body = (
      <>
        {shown.map((row) => (
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
        ))}
      </>
    );
  }
  return (
    <PanelCard
      title="Apps"
      note="Every app on the instance, whichever account owns it."
      controls={
        <SearchForm
          id="admin-app-search"
          label="Search apps by name, slug or owner"
          placeholder="Search by name, slug or owner"
          value={search()}
          onSearch={(value) => {
            search.set(value);
          }}
        />
      }
    >
      <Problems load={loadError} panel={panelError()} />
      {body}
    </PanelCard>
  );
};

/** The invite pool: search it, mint codes, hand them out, revoke what is still
 * open. The search (`?iq=`) matches the code, who made it and who used it. */
export const AdminInvitesPanel = () => {
  const busy = atom(false);
  const res = adminListInvites();
  const invites = res.data() ?? [];
  const loadError = res.error();
  const panelError = atom("");
  const mintCount = atom(3);
  const copied = atom("");
  const search = searchParam("iq", { default: "" });
  const needle = search().trim().toLowerCase();
  const shown = needle
    ? invites.filter((inv) =>
        [inv.code, inv.createdByEmail, inv.usedByEmail, inviteState(inv)].some(
          (field) => field.toLowerCase().includes(needle)
        )
      )
    : invites;

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

  const loading = res.loading() && res.data() === undefined;
  let body: View;
  if (loading) {
    body = <SkeletonRows />;
  } else if (shown.length === 0) {
    body = (
      <li class={EMPTY_ROW}>
        {needle ? "No codes match that search." : "No codes yet."}
      </li>
    );
  } else {
    body = (
      <>
        {shown.map((inv) => (
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
        ))}
      </>
    );
  }
  return (
    <PanelCard
      title="Invites"
      note="Registration is invite-only. Every new account receives 2 codes of its own to hand out."
      controls={
        <SearchForm
          id="admin-invite-search"
          label="Search invites by code or email"
          placeholder="Search by code or email"
          value={search()}
          onSearch={(value) => {
            search.set(value);
          }}
        />
      }
    >
      <Problems load={loadError} panel={panelError()} />
      {body}
      <li class="flex items-center justify-end gap-2 p-4 pt-2">
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
          class={ACTION}
          disabled={busy()}
          onclick={() => {
            void mint();
          }}
        >
          Generate
        </button>
      </li>
    </PanelCard>
  );
};
