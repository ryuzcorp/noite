//! Admin tab: every app on the instance, whichever account owns it.

import { Link } from "@ilha/void";
import { atom } from "ilha";
import type { View } from "ilha";

import { api } from "../api";
import type { AdminAppRow } from "../api-types";
import { presenceTone } from "../apps/identity";
import { errorMessage } from "../errors";
import { listAllApps } from "../resources";
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
  W_SM,
} from "./shared";

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
          <AdminAppRowItem
            key={row.id}
            row={row}
            busy={busy()}
            onToggle={(app) => {
              void mutate(() =>
                api<{ ok: true }>("/api/admin/adminSetAppState", {
                  desiredState:
                    app.desiredState === "running" ? "stopped" : "running",
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

                if (!ok) {
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
