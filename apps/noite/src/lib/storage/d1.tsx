//! D1 admin UI: table grid/panel, row drawer, detail panel.
import {
  columnFilteringFeature,
  constructTable,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/table-core";
import { storeReactivityBindings } from "@tanstack/table-core/store-reactivity-bindings";
import * as Schema from "effect/Schema";
import { atom, unsafe, watch } from "ilha";

import type { AppDetailInfo } from "../app-detail/panel";
import { d1Write, get } from "../apps.server";
import type { D1Preview } from "../runner";
import { readSwrCache, writeSwrCache } from "../swr-cache";
import { StorageTopCard } from "./list";

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
  const columns = (lines[0] ?? "").trim().split(/\s+/u);
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

/** Static table-core feature set for the D1 admin panels (pure object,
 * not an atom — safe at module scope; table-core recommends defining it
 * once outside components). Client-side filtering/sorting/pagination over
 * the preview rows; the runner bounds the preview itself. */
/** Set an uncontrolled input's value by id (URL-seed preset helper). */
const setInputValue = (id: string, value: string) => {
  const el = document.querySelector(`#${CSS.escape(id)}`);
  if (el instanceof HTMLInputElement) {
    el.value = value;
  }
};

/** Lucide pencil + trash-2 for the row Actions column. */
const PENCIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
const TRASH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

/** Sort-direction mark for table headers (if/else — no nested ternary). */
const sortIndicator = (sorted: "asc" | "desc" | false) => {
  if (sorted === "asc") {
    return <span aria-hidden="true">▲</span>;
  }
  if (sorted === "desc") {
    return <span aria-hidden="true">▼</span>;
  }
  return null;
};

const D1_FEATURES = tableFeatures({
  // Vanilla/ilha use needs explicit reactivity bindings — without this
  // slot constructTable crashes reading _reactivity (framework adapters
  // normally provide it). Static like the rest of the set.
  columnFilteringFeature,
  coreReactivityFeature: storeReactivityBindings(),
  filterFns: { includesString: filterFn_includesString },
  filteredRowModel: createFilteredRowModel(),
  globalFilteringFeature,
  paginatedRowModel: createPaginatedRowModel(),
  rowPaginationFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

/** One D1 table as an admin panel: global search + column filter +
 * sortable headers + pagination. Inputs are uncontrolled + onchange so
 * filtering never re-renders (and blurs) mid-typing; atoms update on
 * commit and the table rebuilds from them. */
/** Key for one D1 row update/delete (empty means NULL). */
interface D1Key {
  [column: string]: string | null;
}

/** Key for one D1 row: pk cols when the schema has them, else all
 * values — matches the drawer's convention. */
const d1RowKey = (schema: D1Column[], row: Record<string, string>): D1Key => {
  const pks = schema.filter((c) => c.pk).map((c) => c.name);
  const names = pks.length > 0 ? pks : Object.keys(row);
  const key: D1Key = {};
  for (const name of names) {
    const v = row[name] ?? null;
    key[name] = v === "" ? null : v;
  }
  return key;
};

/** Validate a column seed against known columns (stale URLs fall back). */
const validColumnSeed = (columns: string[], c: string | null): string =>
  c !== null && c !== "" && columns.includes(c) ? c : "";

/** Parse an `id:asc|desc` sort seed against known columns. */
const parseSortSeed = (
  columns: string[],
  raw: string | null
): { desc: boolean; id: string }[] => {
  if (!raw) {
    return [];
  }
  const sep = raw.lastIndexOf(":");
  if (sep === -1) {
    return [];
  }
  const id = raw.slice(0, sep);
  const dir = raw.slice(sep + 1);
  if (!columns.includes(id) || (dir !== "asc" && dir !== "desc")) {
    return [];
  }
  return [{ desc: dir === "desc", id }];
};

/** Delete one D1 row after native confirm. Null = cancelled (no UI
 * change); "" = deleted; otherwise the error message to display. */
const deleteD1Row = async ({
  appId,
  databaseId,
  key,
  table,
}: {
  appId: string;
  databaseId: string;
  key: Record<string, string | null>;
  table: string;
}): Promise<string | null> => {
  // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
  if (!window.confirm(`Delete entry from ${table}?`)) {
    return null;
  }
  try {
    await d1Write({ appId, databaseId, key, op: "delete", table, values: {} });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** Data grid for one D1 table: headers, rows, actions, footer.
 * Presentational — filter/sort/page state lives in D1TablePanel. */
const D1TableGrid = ({
  canNext,
  canPrev,
  currentPage,
  headerCols,
  matchedRows,
  onDeleteRow,
  onEdit,
  onNext,
  onPrev,
  onSize,
  onSort,
  pageCount,
  pageSize,
  totalRows,
  unique,
  viewRows,
}: {
  canNext: boolean;
  canPrev: boolean;
  currentPage: number;
  headerCols: { id: string; sorted: "asc" | "desc" | false }[];
  matchedRows: number;
  onDeleteRow: (row: Record<string, string>) => void;
  onEdit: ((row: Record<string, string>) => void) | null;
  onNext: () => void;
  onPrev: () => void;
  onSize: (n: number) => void;
  onSort: (id: string) => void;
  pageCount: number;
  pageSize: number;
  totalRows: number;
  unique: string[];
  viewRows: { id: string; values: Record<string, string> }[];
}) => {
  if (viewRows.length === 0) {
    return (
      <p class="m-0 text-sm opacity-70">
        {totalRows === 0 ? "(no data)" : "No rows match the current filters."}
      </p>
    );
  }
  return (
    <div class="overflow-x-auto">
      <table class="table-sm table-zebra table">
        <thead>
          <tr>
            {headerCols.map((h) => (
              <th key={h.id}>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 font-bold uppercase"
                  title={`Sort by ${h.id}`}
                  onclick={() => {
                    onSort(h.id);
                  }}
                >
                  {h.id}
                  {sortIndicator(h.sorted)}
                </button>
              </th>
            ))}
            {onEdit ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {viewRows.map((row) => (
            <tr key={row.id}>
              {unique.map((c, ci) => {
                const val = row.values[c] ?? "";
                return (
                  <td key={c}>
                    {ci === 0 && onEdit ? (
                      <button
                        type="button"
                        class="link link-hover"
                        title="Edit entry"
                        onclick={() => {
                          onEdit(row.values);
                        }}
                      >
                        {val === "" ? "—" : val}
                      </button>
                    ) : (
                      val
                    )}
                  </td>
                );
              })}
              {onEdit ? (
                <td class="whitespace-nowrap">
                  <div class="flex items-center gap-1">
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost"
                      title="Edit entry"
                      aria-label="Edit entry"
                      onclick={() => {
                        onEdit(row.values);
                      }}
                    >
                      {unsafe(PENCIL_SVG)}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost text-error"
                      title="Delete entry"
                      aria-label="Delete entry"
                      onclick={() => {
                        onDeleteRow(row.values);
                      }}
                    >
                      {unsafe(TRASH_SVG)}
                    </button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      <div class="flex flex-wrap items-center justify-between gap-2 pt-2">
        <span class="text-sm opacity-60">
          Page {currentPage + 1} of {Math.max(pageCount, 1)} · {matchedRows} of{" "}
          {totalRows} row(s)
        </span>
        <div class="flex items-center gap-2">
          <select
            class="select select-sm w-24"
            aria-label="Rows per page"
            onchange={(e) => {
              const el = e.currentTarget;
              if (el instanceof HTMLSelectElement) {
                onSize(Number(el.value) || 10);
              }
            }}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n} selected={n === pageSize}>
                {n} / page
              </option>
            ))}
          </select>
          <button
            type="button"
            class="btn btn-sm"
            disabled={!canPrev}
            onclick={() => {
              onPrev();
            }}
          >
            Previous
          </button>
          <button
            type="button"
            class="btn btn-sm"
            disabled={!canNext}
            onclick={() => {
              onNext();
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
};

const D1TablePanel = ({
  appId,
  databaseId,
  onChanged,
  onEdit,
  schema,
  table,
  columns,
  rows,
}: {
  appId: string;
  databaseId: string;
  onChanged: () => void;
  onEdit: ((row: Record<string, string>) => void) | null;
  schema: D1Column[];
  table: string;
  columns: string[];
  rows: string[][];
  key?: string;
}) => {
  // Space-split previews can repeat header names — dedupe for stable keys.
  const seen = new Map<string, number>();
  const unique = columns.map((c) => {
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return n === 0 ? c : `${c}_${n + 1}`;
  });
  const data: Record<string, string>[] = rows.map((cells) =>
    Object.fromEntries(unique.map((c, i) => [c, cells[i] ?? ""]))
  );
  // Filter state mirrors into the URL (per-table `d1-<table>-*` params)
  // so filtered views are deep-linkable. Plain URLSearchParams +
  // history.replaceState: no router involvement, no remount risk.
  const urlKey = (suffix: string) => `d1-${table}-${suffix}`;
  const urlParams =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search);
  const seededColumn = validColumnSeed(
    unique,
    urlParams?.get(urlKey("c")) ?? null
  );
  const seededSort = parseSortSeed(
    unique,
    urlParams?.get(urlKey("sort")) ?? null
  );
  const parsedSize = Math.trunc(Number(urlParams?.get(urlKey("s")) ?? ""));
  const query = atom(urlParams?.get(urlKey("q")) ?? "");
  const filterColumn = atom(seededColumn);
  const filterValue = atom(urlParams?.get(urlKey("f")) ?? "");
  const pageIndex = atom(
    Math.max(Math.trunc(Number(urlParams?.get(urlKey("p")) ?? "")) || 0, 0)
  );
  const pageSize = atom(
    [10, 25, 50, 100].includes(parsedSize) ? parsedSize : 10
  );
  const sorting = atom(seededSort);

  const syncUrl = () => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const set = (suffix: string, value: string) => {
      if (value) {
        params.set(urlKey(suffix), value);
      } else {
        params.delete(urlKey(suffix));
      }
    };
    set("q", query());
    set("c", filterColumn());
    set("f", filterValue());
    set("p", pageIndex() > 0 ? String(pageIndex()) : "");
    set("s", pageSize() === 10 ? "" : String(pageSize()));
    const [s] = sorting();
    set("sort", s ? `${s.id}:${s.desc ? "desc" : "asc"}` : "");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      next ? `${window.location.pathname}?${next}` : window.location.pathname
    );
  };

  // Preset the uncontrolled inputs from URL seeds after mount (same
  // requestAnimationFrame pattern as the profile name preset).
  watch.once(() => {
    if (typeof document === "undefined") {
      return;
    }
    window.requestAnimationFrame(() => {
      setInputValue(`d1-search-${table}`, query());
      setInputValue(`d1-filter-${table}`, filterValue());
    });
  });

  const toggleSort = (id: string) => {
    const cur = sorting().find((s) => s.id === id);
    if (!cur) {
      sorting.set([{ desc: false, id }]);
    } else if (cur.desc) {
      sorting.set([]);
    } else {
      sorting.set([{ desc: true, id }]);
    }
    pageIndex.set(0);
    syncUrl();
  };

  // Row delete (confirm + write live module-scope; outcome mirrors here).
  const deleteError = atom("");
  const removeRow = async (row: Record<string, string>) => {
    const outcome = await deleteD1Row({
      appId,
      databaseId,
      key: d1RowKey(schema, row),
      table,
    });
    if (outcome === null) {
      return;
    }
    deleteError.set(outcome);
    if (outcome === "") {
      onChanged();
    }
  };

  const resetFilters = () => {
    query.set("");
    filterColumn.set("");
    filterValue.set("");
    sorting.set([]);
    pageIndex.set(0);
    for (const id of [`d1-search-${table}`, `d1-filter-${table}`]) {
      const el = document.querySelector(`#${CSS.escape(id)}`);
      if (el instanceof HTMLInputElement) {
        el.value = "";
      }
    }
    const col = document.querySelector(`#${CSS.escape(`d1-column-${table}`)}`);
    if (col instanceof HTMLSelectElement) {
      col.value = "";
    }
    syncUrl();
  };

  const t = constructTable({
    columns: unique.map((c) => ({
      accessorKey: c,
      filterFn: "includesString",
      header: c,
    })),
    data,
    features: D1_FEATURES,
    globalFilterFn: "includesString",
    state: {
      columnFilters:
        filterColumn() && filterValue()
          ? [{ id: filterColumn(), value: filterValue() }]
          : [],
      globalFilter: query(),
      pagination: { pageIndex: pageIndex(), pageSize: pageSize() },
      sorting: sorting(),
    },
  });
  const pageRows = t.getRowModel().rows;
  const totalRows = t.getCoreRowModel().rows.length;
  const matchedRows = t.getFilteredRowModel().rows.length;
  const pageCount = t.getPageCount();
  const currentPage = Math.min(pageIndex(), Math.max(pageCount - 1, 0));
  const headerCols = t
    .getHeaderGroups()
    .flatMap((hg) => hg.headers)
    .map((h) => ({ id: h.column.id, sorted: h.column.getIsSorted() }));
  const viewRows = pageRows.map((row) => ({
    id: row.id,
    values: Object.fromEntries(
      unique.map((c) => [c, String(row.getValue(c) ?? "")])
    ),
  }));

  return (
    <div
      key={table}
      class="card bg-base-100 dark:bg-base-200 border-base-300 border shadow-md"
    >
      <div class="card-body gap-4">
        <div class="flex flex-wrap items-end gap-2">
          <fieldset class="fieldset min-w-48 flex-1">
            <label class="label" for={`d1-search-${table}`}>
              Search all columns
            </label>
            <input
              id={`d1-search-${table}`}
              class="input input-sm"
              type="search"
              placeholder="filter text…"
              onchange={(e) => {
                const el = e.currentTarget;
                if (el instanceof HTMLInputElement) {
                  query.set(el.value);
                  pageIndex.set(0);
                  syncUrl();
                }
              }}
            />
          </fieldset>
          <fieldset class="fieldset w-36">
            <label class="label" for={`d1-column-${table}`}>
              Column
            </label>
            <select
              id={`d1-column-${table}`}
              class="select select-sm"
              onchange={(e) => {
                const el = e.currentTarget;
                if (el instanceof HTMLSelectElement) {
                  filterColumn.set(el.value);
                  pageIndex.set(0);
                  syncUrl();
                }
              }}
            >
              <option value="">All columns</option>
              {unique.map((c) => (
                <option key={c} value={c} selected={c === filterColumn()}>
                  {c}
                </option>
              ))}
            </select>
          </fieldset>
          <fieldset class="fieldset min-w-36 flex-1">
            <label class="label" for={`d1-filter-${table}`}>
              Column filter
            </label>
            <input
              id={`d1-filter-${table}`}
              class="input input-sm"
              type="search"
              placeholder="value…"
              onchange={(e) => {
                const el = e.currentTarget;
                if (el instanceof HTMLInputElement) {
                  filterValue.set(el.value);
                  pageIndex.set(0);
                  syncUrl();
                }
              }}
            />
          </fieldset>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onclick={resetFilters}
          >
            Reset
          </button>
        </div>
        {deleteError() ? (
          <p class="text-error m-0 text-sm">{deleteError()}</p>
        ) : null}
        <D1TableGrid
          canNext={currentPage + 1 < pageCount}
          canPrev={pageIndex() !== 0}
          currentPage={currentPage}
          headerCols={headerCols}
          matchedRows={matchedRows}
          onDeleteRow={(row) => {
            void removeRow(row);
          }}
          onEdit={onEdit}
          onNext={() => {
            pageIndex.set(pageIndex() + 1);
            syncUrl();
          }}
          onPrev={() => {
            pageIndex.set(Math.max(pageIndex() - 1, 0));
            syncUrl();
          }}
          onSize={(n) => {
            pageSize.set(n);
            pageIndex.set(0);
            syncUrl();
          }}
          onSort={toggleSort}
          pageCount={pageCount}
          pageSize={pageSize()}
          totalRows={totalRows}
          unique={unique}
          viewRows={viewRows}
        />
      </div>
    </div>
  );
};

/** One PRAGMA table_info column: name, declared type, pk membership. */
interface D1Column {
  name: string;
  pk: boolean;
  type: string;
}

/** One PRAGMA table_info row: pk arrives as a 1-based position number. */
const PragmaRow = Schema.Struct({
  name: Schema.String,
  pk: Schema.optional(Schema.Union([Schema.Number, Schema.Boolean])),
  type: Schema.optional(Schema.String),
});

/** Parse a runner PRAGMA table_info --json payload at the I/O boundary
 * (defensive: the runner ships "[]" when the pragma fails). */
const parseD1Schema = (json: string): D1Column[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const cols: D1Column[] = [];
  for (const entry of raw) {
    let row;
    try {
      row = Schema.decodeUnknownSync(PragmaRow)(entry);
    } catch {
      continue;
    }
    if (row.name !== "") {
      cols.push({
        name: row.name,
        pk: Number(row.pk ?? 0) > 0,
        type: row.type ?? "",
      });
    }
  }
  return cols;
};

/** HTML input kind for one drawer field. */
interface FieldKind {
  step?: string;
  type: string;
}

/** Map a SQLite column affinity to an HTML input type. Datetime values
 * round-trip verbatim (only the preset normalizes space→T for display),
 * so stored formats are never mangled on save. */
const fieldInput = (decltype: string): FieldKind => {
  const upper = decltype.toUpperCase();
  if (upper.includes("INT")) {
    return { type: "number" };
  }
  if (
    upper.includes("REAL") ||
    upper.includes("FLOA") ||
    upper.includes("DOUB")
  ) {
    return { step: "any", type: "number" };
  }
  if (
    (upper.includes("DATE") && upper.includes("TIME")) ||
    upper.includes("TIMESTAMP")
  ) {
    return { type: "datetime-local" };
  }
  if (upper.includes("DATE")) {
    return { type: "date" };
  }
  if (upper.includes("TIME")) {
    return { type: "time" };
  }
  return { type: "text" };
};

/** Create/edit drawer for one D1 table row (daisyUI modal-end). Shared by
 * Add entry (initial null) and row-ID edit. Inputs are uncontrolled and
 * preset once after mount so typing never re-renders; empty means NULL.
 * PK columns lock in edit mode; without a pk the update matches all
 * original values. */
const D1RowDrawer = ({
  appId,
  columns,
  databaseId,
  initial,
  onClose,
  onSaved,
  schema,
  table,
}: {
  appId: string;
  columns: string[];
  databaseId: string;
  initial: Record<string, string> | null;
  onClose: () => void;
  onSaved: () => void;
  schema: D1Column[];
  table: string;
}) => {
  const err = atom("");
  const busy = atom(false);
  // Exit animation without re-render: swapping the modal-box class
  // imperatively keeps the content mounted, so the full drawer slides
  // out intact (an atom flip would reconcile the subtree mid-exit).
  // Unmount via onClose after 100ms (matches noite-drawer-out).
  const beginClose = () => {
    const box = document.querySelector("#d1-row-drawer-box");
    if (
      !(box instanceof HTMLElement) ||
      box.classList.contains("noite-drawer-out")
    ) {
      return;
    }
    box.classList.remove("noite-drawer-in");
    box.classList.add("noite-drawer-out");
    setTimeout(() => {
      onClose();
    }, 100);
  };
  const isEdit = initial !== null;
  const fields =
    schema.length > 0
      ? schema
      : columns.map((name) => ({ name, pk: false, type: "" }));
  const pkCols = fields.filter((c) => c.pk).map((c) => c.name);
  const source = initial ?? {};

  watch.once(() => {
    if (typeof document === "undefined") {
      return;
    }
    window.requestAnimationFrame(() => {
      for (const col of fields) {
        const raw = source[col.name] ?? "";
        setInputValue(
          `d1-field-${table}-${col.name}`,
          fieldInput(col.type).type === "datetime-local"
            ? raw.replace(" ", "T")
            : raw
        );
      }
    });
  });

  const save = async () => {
    if (busy()) {
      return;
    }
    const values: Record<string, string | null> = {};
    for (const col of fields) {
      const el = document.querySelector(
        `#${CSS.escape(`d1-field-${table}-${col.name}`)}`
      );
      if (el instanceof HTMLInputElement && !el.disabled) {
        values[col.name] = el.value === "" ? null : el.value;
      }
    }
    const key = isEdit ? d1RowKey(fields, source) : {};
    busy.set(true);
    try {
      await d1Write({
        appId,
        databaseId,
        key,
        op: isEdit ? "update" : "insert",
        table,
        values,
      });
      err.set("");
      onSaved();
      beginClose();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <div class="modal modal-end modal-open">
      <div
        id="d1-row-drawer-box"
        class="modal-box bg-base-100 dark:bg-base-200 noite-drawer-in w-full max-w-md"
      >
        <h3 class="m-0 text-lg font-bold">
          {isEdit ? "Edit entry" : "Add entry"} · {table}
        </h3>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        {fields.map((col) => {
          const locked = isEdit && col.pk;
          return (
            <fieldset key={col.name} class="fieldset w-full">
              <label class="label" for={`d1-field-${table}-${col.name}`}>
                {col.name}
                {col.type ? (
                  <span class="opacity-60"> · {col.type}</span>
                ) : null}
                {col.pk ? <span class="opacity-60"> · pk</span> : null}
              </label>
              <input
                id={`d1-field-${table}-${col.name}`}
                class="input input-sm w-full"
                type={fieldInput(col.type).type}
                step={fieldInput(col.type).step}
                disabled={locked || busy()}
                placeholder={locked ? "primary key (locked)" : "NULL"}
              />
            </fieldset>
          );
        })}
        <p class="m-0 text-sm opacity-70">
          Empty means NULL.
          {isEdit && pkCols.length === 0
            ? " No primary key: the update matches all original values."
            : null}
        </p>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={busy()}
            onclick={() => {
              beginClose();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-sm btn-neutral"
            disabled={busy()}
            onclick={() => {
              void save();
            }}
          >
            {busy() ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button
          aria-label="Close dialog"
          disabled={busy()}
          onclick={() => {
            beginClose();
          }}
        >
          close
        </button>
      </form>
    </div>
  );
};

/** D1 admin detail: table picker + admin panel + create/edit drawer.
 * Owns picker/drawer/role atoms; the parent only reloads the preview. */
export const D1DetailPanel = ({
  appId,
  databaseId,
  d1Data,
  onSaved,
}: {
  appId: string;
  databaseId: string;
  d1Data: D1Preview;
  onSaved: () => void;
}) => {
  const { tables } = d1Data;
  // Picker seed (validated below); the select stays in sync via
  // reactive `selected`, so no preset is needed on remount.
  const selectedTable = atom(
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("d1-table") ?? "")
  );
  // Collaborator role for write UI (fail-closed until confirmed).
  const seedDetail = readSwrCache<AppDetailInfo>(`app:${appId}:detail`);
  const myRole = atom(seedDetail?.myRole ?? null);
  const appName = atom(seedDetail?.app.name ?? "");
  // Create/edit drawer state (table/schema resolve from the selection).
  const drawer = atom<null | {
    mode: "create" | "edit";
    row: Record<string, string> | null;
  }>(null);

  watch.once(() => {
    void (async () => {
      try {
        const info = await get(appId);
        myRole.set(info.myRole);
        appName.set(info.app.name);
        writeSwrCache(`app:${appId}:detail`, info);
      } catch {
        // Role stays at its seed; write UI stays hidden without push/admin.
      }
    })();
  });

  const current = tables.includes(selectedTable())
    ? selectedTable()
    : (tables[0] ?? "");
  const currentIndex = tables.indexOf(current);
  const { columns: currentColumns, rows: currentRows } =
    currentIndex === -1
      ? { columns: [], rows: [] }
      : parseTable(d1Data.rows[currentIndex] ?? "");
  const canWrite = myRole() === "push" || myRole() === "admin";
  const switchTable = (next: string) => {
    if (!tables.includes(next)) {
      return;
    }
    drawer.set(null);
    selectedTable.set(next);
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("d1-table", next);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`
    );
  };
  const currentSchema = parseD1Schema(d1Data.schemas[currentIndex] ?? "[]");
  const activeDrawer = drawer();
  return (
    <div class="flex flex-col gap-4">
      <StorageTopCard
        actions={
          tables.length === 0 ? (
            <p class="m-0 text-sm opacity-70">(no tables)</p>
          ) : (
            [
              <fieldset key="picker" class="fieldset w-64">
                <select
                  aria-label="Table"
                  class="select select-sm"
                  onchange={(e) => {
                    const el = e.currentTarget;
                    if (el instanceof HTMLSelectElement) {
                      switchTable(el.value);
                    }
                  }}
                >
                  {tables.map((t) => (
                    <option key={t} value={t} selected={t === current}>
                      {t}
                    </option>
                  ))}
                </select>
              </fieldset>,
              canWrite ? (
                <button
                  key="add"
                  type="button"
                  class="btn btn-sm btn-neutral"
                  onclick={() => {
                    drawer.set({ mode: "create", row: null });
                  }}
                >
                  Add entry
                </button>
              ) : null,
            ]
          )
        }
        appId={appId}
        appName={appName()}
        badge="D1"
        subtitle={`${tables.length} table(s)`}
        title={databaseId}
      />
      {current ? (
        <D1TablePanel
          key={current}
          table={current}
          columns={currentColumns}
          rows={currentRows}
          appId={appId}
          databaseId={databaseId}
          onChanged={onSaved}
          schema={currentSchema}
          onEdit={
            canWrite
              ? (row) => {
                  drawer.set({ mode: "edit", row });
                }
              : null
          }
        />
      ) : null}
      {activeDrawer && current ? (
        <D1RowDrawer
          appId={appId}
          columns={currentColumns}
          databaseId={databaseId}
          initial={activeDrawer.row}
          onClose={() => {
            drawer.set(null);
          }}
          onSaved={onSaved}
          schema={currentSchema}
          table={current}
        />
      ) : null}
    </div>
  );
};
