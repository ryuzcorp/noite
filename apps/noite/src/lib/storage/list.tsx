//! Storage inventory lists: badges, rows, per-app + global lists.
import { atom, unsafe, watch } from "ilha";

import { CHEVRON_SVG } from "../apps";
import { listAllStorage, listAppStorage } from "../apps.server";
import type { StorageItem } from "../runner";
import { ListSkeleton } from "../skeletons";
import { readSwrCache, writeSwrCache } from "../swr-cache";

/** Badge label per storage kind (plain badge for every kind). */
const STORAGE_BADGES = {
  d1: { label: "D1" },
  r2: { label: "R2" },
} as const;

const storageBadge = (kind: string) =>
  // SAFETY: kind is an open string from the runner; unknown kinds fall
  // through to the DO default via ?? — the cast only narrows the lookup.
  STORAGE_BADGES[kind as keyof typeof STORAGE_BADGES] ?? {
    label: "DO",
  };

/** Display name for a storage resource id (mirrors StorageDetail's parsing). */
export const resourceDisplayName = (resourceId: string): string => {
  if (resourceId.startsWith("d1:") || resourceId.startsWith("r2:")) {
    return resourceId.slice(3);
  }
  if (resourceId.startsWith("do:")) {
    return resourceId.split(":").slice(2).join(":");
  }
  return resourceId;
};

const storageHref = (s: StorageItem): string =>
  `/storage/${encodeURIComponent(s.appId)}/${encodeURIComponent(s.id)}`;

/** One storage resource row: kind badge, name + id, chevron to detail. */
const StorageRow = ({ item: s }: { item: StorageItem; key?: string }) => (
  <li class="list-row">
    <div>
      <span class="badge badge-sm">{storageBadge(s.kind).label}</span>
    </div>
    <div>
      <div>
        <a href={storageHref(s)} class="link link-hover block truncate">
          {s.name}
        </a>
      </div>
      <div class="text-base-content/70 truncate font-mono text-xs">
        {resourceDisplayName(s.id)}
      </div>
    </div>
    <a
      href={storageHref(s)}
      class="btn btn-sm btn-square btn-ghost shrink-0"
      aria-label={`Open ${s.name} details`}
    >
      <span class="inline-flex h-5 w-5 shrink-0">{unsafe(CHEVRON_SVG)}</span>
    </a>
  </li>
);

/** One app's storage resources, same cards as the Storage page. */
export const AppStorageList = ({ appId }: { appId: string }) => {
  // Cache-first: first paint carries last-good items on every mount.
  const seedItems = readSwrCache<StorageItem[]>(`app:${appId}:storage`);
  const items = atom<StorageItem[]>(seedItems ?? []);
  const loadError = atom("");
  const loaded = atom(seedItems !== null);
  watch.once(() => {
    void (async () => {
      try {
        const fresh = await listAppStorage({ appId });
        items.set(fresh ?? []);
        writeSwrCache(`app:${appId}:storage`, fresh);
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
      loaded.set(true);
    })();
  });

  const emptyView =
    !loaded() && !loadError() ? (
      <li class="px-4 pt-2 pb-4">
        <ListSkeleton rows={2} />
      </li>
    ) : (
      <li class="text-base-content/70 px-4 pt-2 pb-4 text-sm">
        No storage yet. Deploy a version that uses D1, R2, or Durable Objects.
      </li>
    );

  return (
    <div class="flex w-full flex-col gap-4">
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Storage</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
          <a href="/storage" class="btn btn-sm">
            View All
          </a>
        </li>
        {items().length === 0
          ? emptyView
          : items().map((s) => (
              <StorageRow key={`${s.appId}:${s.id}`} item={s} />
            ))}
      </ul>
    </div>
  );
};

/** All storage items across the user's apps (D1 DBs + DO classes). */
export const StorageList = () => {
  // Cache-first: first paint carries last-good items on every mount.
  const seedItems = readSwrCache<StorageItem[]>("all:storage");
  const items = atom<StorageItem[]>(seedItems ?? []);
  const loadError = atom("");
  const loaded = atom(seedItems !== null);
  watch.once(() => {
    void (async () => {
      try {
        const fresh = await listAllStorage();
        items.set(fresh);
        writeSwrCache("all:storage", fresh);
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
      loaded.set(true);
    })();
  });

  const byApp = new Map<string, StorageItem[]>();
  for (const item of items()) {
    const group = byApp.get(item.appId) ?? [];
    group.push(item);
    byApp.set(item.appId, group);
  }
  const emptyView =
    !loaded() && !loadError() ? (
      <li class="px-4 pt-2 pb-4">
        <ListSkeleton rows={3} />
      </li>
    ) : (
      <li class="text-base-content/70 px-4 pt-2 pb-4 text-sm">
        No storage yet. Deploy an app that uses D1, R2, or Durable Objects.
      </li>
    );

  // Flat rows: one group header li per app, then its resource rows.
  const rows = [...byApp].flatMap(([appId, group], index) => [
    <li
      key={`group:${appId}`}
      class={`px-4 pb-2 ${index === 0 ? "pt-2" : "pt-4"}`}
    >
      <span class="text-xs tracking-wide opacity-60">{group[0].appName}</span>
    </li>,
    ...group.map((s) => <StorageRow key={`${s.appId}:${s.id}`} item={s} />),
  ]);

  return (
    <div class="flex w-full flex-col gap-4">
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Storage</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
        </li>
        {items().length === 0 ? emptyView : rows}
      </ul>
    </div>
  );
};
