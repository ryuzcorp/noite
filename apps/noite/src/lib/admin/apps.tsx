//! Admin tab: every app on the instance, whichever account owns it.

import { Link } from "@ilha/void";
import { atom, watch } from "ilha";
import type { View } from "ilha";

import { api } from "../api";
import type { AdminAppRow } from "../api-types";
import { presenceTone } from "../apps/identity";
import { resourceValue, resourceError } from "../resource";
import { listAllApps } from "../resources";
import { searchParam } from "../search-param";
import { Avatar } from "../ui/avatar";
import { confirmDialog } from "../ui/confirm";
import { actionDesiredState } from "./runtime";
import {
  ACTION,
  AdminRow,
  DANGER,
  EMPTY_ROW,
  PanelCard,
  Problems,
  SearchForm,
  SkeletonRows,
  W_SM,
  mutatePanel,
} from "./shared";

/** The button label for the runtime's action (`null`: nothing to do). */
const toggleLabel = (next: AdminAppRow["next"]): string => {
  if (next === "stop") {
    return "Stop";
  }

  return next === "start" ? "Start" : "—";
};

interface AdminAppRowProps {
  busy: boolean;
  onDelete: (row: AdminAppRow) => void;
  onToggle: (row: AdminAppRow) => void;
  row: AdminAppRow;
}

const AdminAppRowItem = ({
  busy,
  onDelete,
  onToggle,
  row,
}: AdminAppRowProps) => (
  <AdminRow
    avatar={
      <Avatar
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
          // `next` is the server's derived action (lib/admin/runtime): an
          // unsettled or unknown runtime offers none, so the panel can never
          // send a start to an app that is already running.
          disabled={busy || row.next === null}
          onclick={() => {
            onToggle(row);
          }}
        >
          {toggleLabel(row.next)}
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
    <Link
      href={`/apps/${row.id}`}
      class="link link-hover block truncate font-medium"
    >
      {row.name}
    </Link>
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

/** Every app on the instance, whichever account owns it: filter by name,
 * slug or owner; start, stop or delete any of them. The search lives in the
 * URL (`?aq=`) and narrows the loaded list in the browser. */
/** How often the panel re-reads while a row is transitional (start/stop is
 * asynchronous runner-side; one-shot refetch caught a mid-flight row and then
 * froze, so a "Start" click could leave a dead row). */
const TRANSITION_POLL_MS = 2000;

export const AdminAppsPanel = () => {
  const res = listAllApps();
  const search = searchParam("aq", { default: "" });
  const busy = atom(false);
  const panelError = atom("");
  const apps = resourceValue(res.state()) ?? [];
  const loadError = resourceError(res.state());
  const needle = search().trim().toLowerCase();

  // Track transitional rows until they settle: the mutation already refetched
  // once, but the runner may still be moving.
  watch.once(({ signal }) => {
    if (typeof window === "undefined") {
      return;
    }

    const timer = window.setInterval(() => {
      if (signal.aborted) {
        return;
      }

      const rows = resourceValue(res.state()) ?? [];

      if (rows.some((row) => row.runtime === "transitioning")) {
        void (async () => {
          try {
            await res.refetch();
          } catch {
            // The next tick retries; the panel's own error line stays as is.
          }
        })();
      }
    }, TRANSITION_POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  });

  const shown = needle
    ? apps.filter((app) =>
        [app.name, app.slug, app.ownerEmail].some((field) =>
          field.toLowerCase().includes(needle)
        )
      )
    : apps;

  const mutate = async <T,>(work: () => Promise<T>): Promise<void> => {
    await mutatePanel(busy, panelError, () => res.refetch(), work);
  };

  const loading = res.state()._tag === "Loading";
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
          <AdminAppRowItem
            key={row.id}
            row={row}
            busy={busy()}
            onToggle={(app) => {
              const { next } = app;

              if (next === null) {
                return;
              }

              void mutate(() =>
                api<{ ok: true }>("/api/admin/adminSetAppState", {
                  desiredState: actionDesiredState(next),
                  id: app.id,
                })
              );
            }}
            onDelete={(app) => {
              void (async () => {
                const ok = await confirmDialog({
                  confirmLabel: "Delete",
                  message:
                    "This removes the app, its git remote and its fleet.",
                  title: `Delete ${app.name} (${app.slug})?`,
                });

                if (ok !== "confirm") {
                  return;
                }

                await mutate(() =>
                  api<{ ok: true }>("/api/admin/adminDeleteApp", app.id)
                );
              })();
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
