//! Storage inventory rows: badges, rows, per-app list.
import { Link } from "@ilha/void";

import { errorMessage } from "../errors";
import { appStorage } from "../resources";
import type { StorageItem } from "../runner";
import { ChevronRight } from "../ui/icons";
import { ListSkeleton } from "../ui/skeletons";
import { resourceDisplayName } from "./names";

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

const storageHref = (s: StorageItem): string =>
  `/storage/${encodeURIComponent(s.appId)}/${encodeURIComponent(s.id)}`;

/** One storage resource row: kind badge, name + id, chevron to detail. */
const StorageRow = ({ item: s }: { item: StorageItem }) => (
  <li class="list-row">
    <div>
      <span class="badge badge-sm">{storageBadge(s.kind).label}</span>
    </div>
    <div>
      <div>
        <Link href={storageHref(s)} class="link link-hover block truncate">
          {s.name}
        </Link>
      </div>
      <div class="text-base-content/70 truncate font-mono text-xs">
        {resourceDisplayName(s.id)}
      </div>
    </div>
    <Link
      href={storageHref(s)}
      class="btn btn-sm btn-square btn-ghost shrink-0"
      aria-label={`Open ${s.name} details`}
    >
      <span class="inline-flex h-5 w-5 shrink-0">
        <ChevronRight class="h-5 w-5" />
      </span>
    </Link>
  </li>
);

/** One app's storage resources, shown on the app overview tab. */
export const AppStorageList = ({ appId }: { appId: string }) => {
  const res = appStorage(appId);
  const items = res.data() ?? [];
  const loadError = res.error();

  const emptyView =
    res.loading() && res.data() === undefined ? (
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
      {loadError ? (
        <p class="text-error m-0 text-sm">{errorMessage(loadError)}</p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Storage</span>
            <span class="badge badge-sm">{items.length}</span>
          </span>
        </li>
        {items.length === 0
          ? emptyView
          : items.map((s) => (
              <StorageRow key={`${s.appId}:${s.id}`} item={s} />
            ))}
      </ul>
    </div>
  );
};
