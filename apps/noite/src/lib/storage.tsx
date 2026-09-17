import { atom, unsafe, watch } from "ilha";

import { CHEVRON_SVG } from "./apps";
import {
  d1Preview,
  doPreview,
  listAllStorage,
  listAppStorage,
  r2Delete,
  r2List,
} from "./apps.server";
import { r2DownloadUrl } from "./runner";
import type { D1Preview, DoPreview, R2Preview, StorageItem } from "./runner";
import { ListSkeleton, SectionSkeleton } from "./skeletons";
import { readSwrCache, writeSwrCache } from "./swr-cache";

/** celld d1 prints each result set as a space-padded table: a header line,
 * a rule line of dashes, then the data rows. Turn that into columns + rows
 * so the detail page can render it with a daisyUI table. */
interface ParsedTable {
  columns: string[];
  rows: string[][];
}

const parseTable = (text: string): ParsedTable => {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { columns: [], rows: [] };
  }
  const columns = lines[0].trim().split(/\s+/u);
  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    // The dashes rule under the header carries no data.
    if (/^[-+\s]+$/u.test(line)) {
      continue;
    }
    const cells = line.trim().split(/\s+/u);
    if (cells.length >= columns.length) {
      // A value containing a space makes the row longer than the header;
      // merge the extra cells into the last column instead of dropping them.
      rows.push([
        ...cells.slice(0, columns.length - 1),
        cells.slice(columns.length - 1).join(" "),
      ]);
    } else {
      rows.push([
        ...cells,
        ...Array.from({ length: columns.length - cells.length }, () => ""),
      ]);
    }
  }
  return { columns, rows };
};

/** Badge label + tone per storage kind (D1 blue, R2 purple, DO ghost). */
const STORAGE_BADGES = {
  d1: { label: "D1", tone: "badge-primary" },
  r2: { label: "R2", tone: "badge-secondary" },
} as const;

const storageBadge = (kind: string) =>
  // SAFETY: kind is an open string from the runner; unknown kinds fall
  // through to the DO default via ?? — the cast only narrows the lookup.
  STORAGE_BADGES[kind as keyof typeof STORAGE_BADGES] ?? {
    label: "DO",
    tone: "badge-ghost",
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
const StorageRow = ({ item: s }: { item: StorageItem }) => (
  <li class="list-row">
    <div>
      <span class={`badge badge-sm ${storageBadge(s.kind).tone}`}>
        {storageBadge(s.kind).label}
      </span>
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
      class="btn btn-square btn-ghost btn-sm shrink-0"
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
        items.set(fresh);
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

/** One storage resource's details: D1 shows each table as a read-only
 * daisyUI table (rows + first rows); a DO class shows its live instances;
 * an R2 bucket lists keys with a bounded text preview per file.
 * celld exposes no read route for a DO instance's stored data, so the
 * instance enumeration is the operator's view. */
export const StorageDetail = ({
  appId,
  resourceId,
}: {
  appId: string;
  resourceId: string;
}) => {
  const isD1 = resourceId.startsWith("d1:");
  const isR2 = resourceId.startsWith("r2:");
  const databaseId = isD1 ? resourceId.slice(3) : resourceId;
  const bucket = isR2 ? resourceId.slice(3) : resourceId;
  // DO resource ids are "do:{Binding}:{Name}" — the class is everything
  // after the binding, and either part may itself contain a colon.
  const className = resourceId.startsWith("do:")
    ? resourceId.split(":").slice(2).join(":")
    : resourceId;
  const preview = atom<D1Preview | DoPreview | R2Preview | null>(null);
  const fileError = atom("");
  const loadError = atom("");

  const reloadR2 = async () => {
    try {
      const p = await r2List({ appId, bucket });
      // SAFETY: same unwrap edge as the D1 branch — raw R2Preview JSON.
      preview.set((p as R2Preview | null) ?? null);
      fileError.set("");
    } catch (error) {
      fileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteFile = async (key: string) => {
    // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
    if (!window.confirm(`Delete ${key} from ${bucket}?`)) {
      return;
    }
    try {
      await r2Delete({ appId, bucket, key });
      await reloadR2();
    } catch (error) {
      fileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  watch.once(() => {
    void (async () => {
      try {
        if (isR2) {
          await reloadR2();
        } else if (isD1) {
          const p = await d1Preview({ appId, databaseId });
          // SAFETY: oxide action returns unwrap to the raw runner JSON here
          // (D1Preview); the `Effect<...>` variant is the action's typing edge
          // that erases at runtime.
          preview.set((p as D1Preview | null) ?? null);
        } else if (resourceId.startsWith("do:")) {
          const p = await doPreview({ appId, className });
          // SAFETY: the doPreview action returns the runner's DoPreview as
          // unwrap (raw JSON), the same typing edge as the D1 branch above.
          preview.set((p as DoPreview | null) ?? null);
        }
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  if (loadError()) {
    return <p class="text-error m-0 text-sm">{loadError()}</p>;
  }
  if (!preview()) {
    return <SectionSkeleton lines={5} />;
  }
  const p = preview();
  if (!p) {
    return null;
  }

  if (isR2) {
    // SAFETY: reached only when isR2, where the watch branch stores an
    // R2Preview (the union covers the D1/DO siblings in the same atom).
    const r2Data = p as R2Preview;
    return (
      <div class="flex flex-col gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="badge badge-secondary">R2</span>
            <h1 class="m-0 text-lg font-semibold">{bucket}</h1>
          </div>
          <p class="m-0 text-sm opacity-70">
            {r2Data.objects.length} object(s)
          </p>
        </div>
        {r2Data.objects.length === 0 ? (
          <p class="m-0 text-sm opacity-70">
            No objects yet — PUT to /files/&lt;key&gt; on the app to upload one.
          </p>
        ) : (
          <div class="card bg-base-100 dark:bg-base-200 border-base-300 border shadow-md">
            <div class="card-body gap-4">
              <div class="overflow-x-auto">
                <table class="table-sm table-zebra table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Size</th>
                      <th>Uploaded</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {r2Data.objects.map((object) => (
                      <tr key={object.key}>
                        <td class="font-mono text-xs">{object.key}</td>
                        <td class="font-mono text-xs">{object.size}</td>
                        <td class="font-mono text-xs">
                          {object.lastModified || "—"}
                        </td>
                        <td class="whitespace-nowrap">
                          <a
                            class="btn btn-ghost btn-xs"
                            href={r2DownloadUrl(appId, bucket, object.key)}
                            download={object.key.split("/").pop() ?? object.key}
                          >
                            Download
                          </a>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs text-error"
                            onclick={() => {
                              void deleteFile(object.key);
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        {fileError() ? (
          <p class="text-error m-0 text-sm">{fileError()}</p>
        ) : null}
      </div>
    );
  }

  if (!isD1) {
    // SAFETY: this branch only ever stored a DoPreview (the do: watch branch
    // above); the atom base type unions D1Preview in for the D1 sibling.
    const doData = p as DoPreview;
    return (
      <div class="flex flex-col gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="badge badge-ghost">DO</span>
            <h1 class="m-0 text-lg font-semibold">{className}</h1>
          </div>
          <p class="m-0 text-sm opacity-70">
            {doData.instances.length} instance(s)
          </p>
        </div>
        {doData.instances.length === 0 ? (
          <p class="m-0 text-sm opacity-70">
            No instances yet — one is created the first time the object is
            called.
          </p>
        ) : (
          <div class="card bg-base-100 dark:bg-base-200 border-base-300 border shadow-md">
            <div class="card-body gap-4">
              <div class="overflow-x-auto">
                <table class="table-sm table-zebra table">
                  <thead>
                    <tr>
                      <th>Instance ID</th>
                      <th>Preview (?read=1)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doData.instances.map((instance) => (
                      <tr key={instance.id}>
                        <td class="font-mono text-xs">{instance.id}</td>
                        <td class="font-mono text-xs whitespace-pre-wrap">
                          {instance.preview ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // SAFETY: reached only when isD1, where the watch branch stores a
  // D1Preview (the union is DoPreview's sibling in the same atom).
  const d1Data = p as D1Preview;
  return (
    <div class="flex flex-col gap-4">
      <div>
        <div class="flex items-center gap-2">
          <span class="badge badge-primary">D1</span>
          <h1 class="m-0 text-lg font-semibold">{databaseId}</h1>
        </div>
        <p class="m-0 text-sm opacity-70">{d1Data.tables.length} table(s)</p>
      </div>
      {d1Data.tables.map((table, index) => {
        const { columns, rows } = parseTable(d1Data.rows[index] ?? "");
        return (
          <div
            key={table}
            class="card bg-base-100 dark:bg-base-200 border-base-300 border shadow-md"
          >
            <div class="card-body gap-4">
              <h3 class="m-0 text-lg font-semibold">{table}</h3>
              {rows.length === 0 ? (
                <p class="m-0 text-sm opacity-70">(no data)</p>
              ) : (
                <div class="overflow-x-auto">
                  <table class="table-sm table-zebra table">
                    <thead>
                      <tr>
                        {columns.map((column, i) => (
                          <th key={i}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
