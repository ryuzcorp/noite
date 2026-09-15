import { atom, watch } from "ilha";

import {
  d1Preview,
  doPreview,
  listAllStorage,
  listAppStorage,
  r2Delete,
  r2List,
} from "./apps.server";
import { Breadcrumbs } from "./breadcrumbs";
import { r2DownloadUrl } from "./runner";
import type { D1Preview, DoPreview, R2Preview, StorageItem } from "./runner";

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

/** One storage resource card: name links to its detail page, kind badge. */
const StorageCard = ({ item: s }: { item: StorageItem }) => (
  <div class="card bg-base-100 w-full shadow-sm">
    <div class="card-body gap-3">
      <div class="flex items-start justify-between gap-2">
        <a
          href={`/storage/${encodeURIComponent(s.appId)}/${encodeURIComponent(s.id)}`}
          class="link link-hover card-title m-0"
        >
          {s.name}
        </a>
        <span class={`badge badge-sm ${storageBadge(s.kind).tone}`}>
          {storageBadge(s.kind).label}
        </span>
      </div>
    </div>
  </div>
);

/** One app's storage resources, same cards as the Storage page. */
export const AppStorageList = ({ appId }: { appId: string }) => {
  const items = atom<StorageItem[]>([]);
  const loadError = atom("");
  watch.once(() => {
    void (async () => {
      try {
        items.set(await listAppStorage({ appId }));
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  return (
    <div class="flex w-full flex-col gap-4">
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      <div class="flex items-center gap-2">
        <Breadcrumbs trail={[{ label: "Storage" }]} />
        <span class="badge badge-primary">{items().length}</span>
      </div>
      {items().length === 0 ? (
        <p class="m-0 opacity-70">
          No storage yet. Deploy a version that uses D1, R2, or Durable Objects.
        </p>
      ) : (
        <div class="flex flex-col gap-3">
          {items().map((s) => (
            <StorageCard key={`${s.appId}:${s.id}`} item={s} />
          ))}
        </div>
      )}
    </div>
  );
};

/** All storage items across the user's apps (D1 DBs + DO classes). */
export const StorageList = () => {
  const items = atom<StorageItem[]>([]);
  const loadError = atom("");
  watch.once(() => {
    void (async () => {
      try {
        items.set(await listAllStorage());
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  const byApp = new Map<string, StorageItem[]>();
  for (const item of items()) {
    const group = byApp.get(item.appId) ?? [];
    group.push(item);
    byApp.set(item.appId, group);
  }

  return (
    <div class="flex w-full flex-col gap-4">
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      <div class="flex items-center gap-2">
        <Breadcrumbs trail={[{ label: "Storage" }]} />
        <span class="badge badge-primary">{items().length}</span>
      </div>
      {items().length === 0 ? (
        <p class="m-0 opacity-70">
          No storage yet. Deploy an app that uses D1, R2, or Durable Objects.
        </p>
      ) : (
        <div class="flex w-full flex-col gap-6">
          {[...byApp].map(([appId, group]) => (
            <div key={appId} class="flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2">
                <h3 class="m-0 text-lg font-semibold">{group[0].appName}</h3>
                <span class="badge badge-ghost badge-sm">{group.length}</span>
              </div>
              <div class="flex flex-col gap-3">
                {group.map((s) => (
                  <StorageCard key={`${s.appId}:${s.id}`} item={s} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
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
    return <p class="m-0 opacity-70">Loading…</p>;
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
          <Breadcrumbs
            trail={[{ href: "/storage", label: "Storage" }, { label: bucket }]}
          />
          <div class="flex items-center gap-2">
            <span class="badge badge-secondary">R2</span>
            <h1 class="m-0 text-2xl font-semibold">{bucket}</h1>
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
          <div class="card bg-base-100 shadow">
            <div class="card-body gap-2">
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
          <Breadcrumbs
            trail={[
              { href: "/storage", label: "Storage" },
              { label: className },
            ]}
          />
          <div class="flex items-center gap-2">
            <span class="badge badge-ghost">DO</span>
            <h1 class="m-0 text-2xl font-semibold">{className}</h1>
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
          <div class="card bg-base-100 shadow">
            <div class="card-body gap-2">
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
        <Breadcrumbs
          trail={[
            { href: "/storage", label: "Storage" },
            { label: databaseId },
          ]}
        />
        <div class="flex items-center gap-2">
          <span class="badge badge-primary">D1</span>
          <h1 class="m-0 text-2xl font-semibold">{databaseId}</h1>
        </div>
        <p class="m-0 text-sm opacity-70">{d1Data.tables.length} table(s)</p>
      </div>
      {d1Data.tables.map((table, index) => {
        const { columns, rows } = parseTable(d1Data.rows[index] ?? "");
        return (
          <div key={table} class="card bg-base-100 shadow">
            <div class="card-body gap-2">
              <h3 class="m-0 text-lg font-medium">{table}</h3>
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
