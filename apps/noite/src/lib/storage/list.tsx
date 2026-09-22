//! Storage inventory rows: badges, rows, per-app list.
import { atom, unsafe, watch } from "ilha";
import type { View } from "ilha";

import { ARROW_LEFT_SVG } from "../app-detail/icons";
import { CHEVRON_SVG } from "../apps";
import { listAppStorage } from "../apps.server";
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

/** One app's storage resources, shown on the app overview tab. */
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
        <li class="flex items-center gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Storage</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
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

/** Shared top card for storage detail pages (D1, R2, DO): back link to the
 * app, kind badge + title + subtitle on the left, optional right-side
 * addons (table picker, buttons) — omit them where there's nothing to act
 * on. */
export const StorageTopCard = ({
  actions,
  appId,
  appName,
  badge,
  subtitle,
  title,
}: {
  actions?: View;
  appId: string;
  appName: string;
  badge: string;
  subtitle: string;
  title: string;
}) => (
  <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
    <div class="card-body gap-4">
      <a
        href={`/apps/${appId}`}
        class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
      >
        {unsafe(ARROW_LEFT_SVG)}
        {appName || "…"}
      </a>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="flex items-center gap-2">
            <span class="badge">{badge}</span>
            <h1 class="m-0 text-lg font-semibold">{title}</h1>
          </div>
          <p class="m-0 text-sm opacity-70">{subtitle}</p>
        </div>
        {actions ? (
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  </div>
);
