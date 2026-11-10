//! The Durable Object viewer: a breadcrumb header, an instance search over
//! id/scope, the instance list, and a detail panel that renders the object's
//! own `?read=1` response as a key/value table with copy buttons. Read-only:
//! celld exposes no generic storage read for a DO instance, so the app's
//! handler decides what a preview shows — the UI only presents it.

import { atom } from "ilha";
import type { View } from "ilha";

import { errorMessage } from "../../errors";
import { resourceValue } from "../../resource";
import { doPreview } from "../../resources";
import type { DoPreview } from "../../runner";
import { searchParam } from "../../search-param";
import { CopyButton } from "../../ui/copy-button";
import { Refresh, Search } from "../../ui/icons";
import {
  DetailPanel,
  EmptyState,
  prettyJson,
  StorageBreadcrumb,
} from "../shared";
import { doBodyOf, doSummary } from "./body";

type DoInstance = DoPreview["instances"][number];

/** The selected instance's storage preview: a key/value table for a JSON
 * object, the pretty body for anything else, and an explanation when the
 * probe came back empty. Keyed by instance id in DoBrowser. */
const DoInstancePanel = ({ instance }: { instance: DoInstance }) => {
  const { preview } = instance;
  const body = doBodyOf(preview);

  if (body._tag === "Silent") {
    return (
      <DetailPanel title={instance.id}>
        <p class="m-0 text-sm opacity-60">
          The object reported no storage preview. That happens when it is not
          running, when it has no <code>?read=1</code> handler, or when the
          probe failed — celld does not tell the UI which.
        </p>
      </DetailPanel>
    );
  }

  const table =
    body._tag === "Json" ? (
      <table class="table-xs table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th class="w-20" />
          </tr>
        </thead>
        <tbody>
          {body.entries.map((entry) => (
            <tr key={entry.key}>
              <td class="align-top font-mono text-xs whitespace-nowrap">
                {entry.key}
              </td>
              <td class="align-top">
                <pre class="m-0 max-h-64 overflow-auto text-xs whitespace-pre-wrap">
                  {entry.value}
                </pre>
              </td>
              <td class="text-right align-top">
                <CopyButton label={`Copy ${entry.key}`} value={entry.value} />
              </td>
            </tr>
          ))}
          {body.entries.length === 0 ? (
            <tr>
              <td class="opacity-60" colspan={3}>
                The object reports an empty state.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    ) : null;

  return (
    <DetailPanel title={instance.id}>
      <p class="m-0 flex items-center gap-2 text-xs opacity-60">
        <span class="badge badge-ghost badge-sm">Scope</span>
        <span class="truncate font-mono" title={instance.scope}>
          {instance.scope}
        </span>
      </p>
      {table}
      {body._tag === "Text" ? (
        <>
          <div class="flex justify-end">
            <CopyButton label="Copy the instance preview" value={body.body} />
          </div>
          <pre class="bg-base-200 dark:bg-base-300/50 m-0 max-h-[32rem] overflow-auto rounded-lg p-2 text-xs whitespace-pre-wrap">
            {prettyJson(body.body)}
          </pre>
        </>
      ) : null}
      <p class="m-0 mt-auto text-xs opacity-60">
        Read-only. celld keeps an instance's storage in its cell; this preview
        is the app's own <code>?read=1</code> response.
      </p>
    </DetailPanel>
  );
};

/** One Durable Object class: instance search, the list, and the preview
 * panel for the selected instance. */
export const DoBrowser = ({
  appId,
  appName,
  className,
}: {
  appId: string;
  appName: string;
  className: string;
}) => {
  const res = doPreview(appId, className);
  const query = searchParam("q", { default: "" });
  const selected = atom<string | null>(null);
  const state = res.state();
  const data = resourceValue(state);

  if (data === undefined) {
    if (state._tag === "Failed") {
      return (
        <p class="text-error m-0 p-4 text-sm">{errorMessage(state.error)}</p>
      );
    }

    return (
      <div class="flex flex-col gap-2 p-4">
        <span class="skeleton h-8 w-full" />
        <span class="skeleton h-6 w-full" />
        <span class="skeleton h-6 w-full" />
      </div>
    );
  }

  const needle = query().trim().toLowerCase();

  const instances =
    needle === ""
      ? data.instances
      : data.instances.filter(
          (instance) =>
            instance.id.toLowerCase().includes(needle) ||
            instance.scope.toLowerCase().includes(needle)
        );

  const selectedInstance =
    data.instances.find((instance) => instance.id === selected()) ?? null;

  let body: View;

  if (data.instances.length === 0) {
    body = (
      <EmptyState
        hint="An instance is created the first time the object is called."
        title="No instances yet"
      />
    );
  } else if (instances.length === 0) {
    body = (
      <EmptyState
        hint="No instance id or scope matches this search."
        title="No matches"
      />
    );
  } else {
    body = (
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="table-sm table-pin-rows table w-full">
          <thead>
            <tr>
              <th class="whitespace-nowrap">Instance ID</th>
              <th class="whitespace-nowrap">Scope</th>
              <th class="whitespace-nowrap">State</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((instance) => (
              <tr
                key={instance.id}
                class={`hover cursor-pointer ${selected() === instance.id ? "bg-base-200 dark:bg-base-300/50" : ""}`}
                onclick={() => {
                  selected.set(instance.id);
                }}
              >
                <td class="max-w-md truncate font-mono text-xs">
                  {instance.id}
                </td>
                <td class="max-w-md truncate font-mono text-xs opacity-80">
                  {instance.scope}
                </td>
                <td
                  class={`max-w-md truncate text-xs ${instance.preview === null ? "opacity-50" : ""}`}
                  title={instance.preview ?? undefined}
                >
                  {doSummary(doBodyOf(instance.preview))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {state._tag === "Failed" ? (
        <p class="text-error m-0 px-3 py-1 text-sm" role="alert">
          {errorMessage(state.error)} — showing the last loaded instances.
        </p>
      ) : null}
      <div class="border-base-300 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
        <StorageBreadcrumb
          crumbs={[
            { href: `/apps/${appId}`, label: appName || "App" },
            { label: "Durable Objects" },
            { label: className },
          ]}
        />
        <span class="badge badge-sm ml-auto shrink-0">DO</span>
      </div>
      <div class="border-base-300 flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <label class="input input-sm w-64 max-w-full">
          <Search class="h-4 w-4 opacity-50" />
          <input
            type="search"
            aria-label="Search instances"
            placeholder="Search instances…"
            value={query()}
            oninput={(event) => {
              query.set(event.currentTarget.value);
            }}
          />
        </label>
        <button
          type="button"
          class="btn btn-square btn-ghost btn-sm"
          aria-label="Refresh instances"
          title="Refresh"
          onclick={() => {
            res.refetch();
          }}
        >
          <Refresh />
        </button>
        <span class="badge badge-ghost badge-sm ml-auto">Read-only</span>
      </div>
      <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          {body}
          <div class="border-base-300 border-t px-3 py-2 text-sm opacity-60">
            {data.instances.length} instance
            {data.instances.length === 1 ? "" : "s"}
          </div>
        </div>
        {selectedInstance === null ? (
          <DetailPanel title="Details">
            <p class="m-0 text-sm opacity-60">
              {selected() === null
                ? "Select an instance to read the state its handler reports."
                : "The selected instance is gone. Pick another one."}
            </p>
          </DetailPanel>
        ) : (
          <DoInstancePanel
            key={selectedInstance.id}
            instance={selectedInstance}
          />
        )}
      </div>
    </div>
  );
};
