//! D1 admin UI: table grid/panel, row drawer, detail panel.
import { searchParam } from "@ilha/router";
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
import { atom } from "ilha";

import { d1Write } from "../apps.server";
import { Dialog } from "../dialog";
import { Pencil, Trash } from "../icons";
import { appDetail } from "../resources";
import type { D1Preview } from "../runner";
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

/** Parse `?p=`-style page indexes: garbage falls back to the first page. */
const toPageIndex = (raw: string): number =>
  Math.max(Math.trunc(Number(raw)) || 0, 0);

/** Parse `?s=`-style page sizes: unknown sizes fall back to 10. */
const toPageSize = (raw: string): number => {
  const n = Math.trunc(Number(raw));
  return [10, 25, 50, 100].includes(n) ? n : 10;
};

/** Encode a table sort for `d1-<table>-sort` (`id:asc|desc`, "" when idle). */
const serializeSort = (sorting: { desc: boolean; id: string }[]): string => {
  const [s] = sorting;
  return s ? `${s.id}:${s.desc ? "desc" : "asc"}` : "";
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
                      <Pencil />
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
                      <Trash />
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
              onSize(Number(e.currentTarget.value) || 10);
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
  // Filter state lives in per-table `d1-<table>-*` URL params so filtered
  // views are deep-linkable (writing a default removes the param).
  // D1TablePanel is keyed by table, so these bindings rebuild with it.
  // validColumnSeed / parseSortSeed validate seeds against known columns.
  const query = searchParam(`d1-${table}-q`, { default: "" });
  const filterColumn = searchParam(`d1-${table}-c`, {
    default: "",
    parse: (raw: string) => validColumnSeed(unique, raw),
  });
  const filterValue = searchParam(`d1-${table}-f`, { default: "" });
  const pageIndex = searchParam(`d1-${table}-p`, {
    default: 0,
    parse: toPageIndex,
  });
  const pageSize = searchParam(`d1-${table}-s`, {
    default: 10,
    parse: toPageSize,
  });
  const sorting = searchParam<{ desc: boolean; id: string }[]>(
    `d1-${table}-sort`,
    {
      default: [],
      parse: (raw: string) => parseSortSeed(unique, raw),
      serialize: serializeSort,
    }
  );

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
              value={query()}
              oninput={(e) => {
                query.set(e.currentTarget.value);
                pageIndex.set(0);
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
              value={filterColumn()}
              onchange={(e) => {
                filterColumn.set(e.currentTarget.value);
                pageIndex.set(0);
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
              value={filterValue()}
              oninput={(e) => {
                filterValue.set(e.currentTarget.value);
                pageIndex.set(0);
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
          }}
          onPrev={() => {
            pageIndex.set(Math.max(pageIndex() - 1, 0));
          }}
          onSize={(n) => {
            pageSize.set(n);
            pageIndex.set(0);
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
 * Add entry (initial null) and row-ID edit. Field values live in a
 * `values` atom seeded from `initial`; empty means NULL. PK columns
 * lock in edit mode; without a pk the update matches all original
 * values. */
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
  // Per-instance: the drawer mounts once per open, so this starts true
  // every time. (A parent-owned atom stayed false after an Esc/backdrop
  // close — <Dialog>'s onclose writes it — and the next open never showed.)
  const open = atom(true);
  const err = atom("");
  const busy = atom(false);
  const isEdit = initial !== null;
  const fields =
    schema.length > 0
      ? schema
      : columns.map((name) => ({ name, pk: false, type: "" }));
  const pkCols = fields.filter((c) => c.pk).map((c) => c.name);
  const source = initial ?? {};
  const seedValues = () => {
    const seeded: Record<string, string> = {};
    for (const col of fields) {
      const raw = source[col.name] ?? "";
      seeded[col.name] =
        fieldInput(col.type).type === "datetime-local"
          ? raw.replace(" ", "T")
          : raw;
    }
    return seeded;
  };
  const values = atom<Record<string, string>>(seedValues());

  const save = async () => {
    if (busy()) {
      return;
    }
    const snapshot = values();
    const payload: Record<string, string | null> = {};
    for (const col of fields) {
      if (isEdit && col.pk) {
        continue;
      }
      const current = snapshot[col.name] ?? "";
      payload[col.name] = current === "" ? null : current;
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
        values: payload,
      });
      err.set("");
      onSaved();
      onClose();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <Dialog open={open} class="modal modal-end" onClose={onClose}>
      <div class="modal-box bg-base-100 dark:bg-base-200 w-full max-w-md">
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
                value={values()[col.name] ?? ""}
                oninput={(e) => {
                  values.set({
                    ...values(),
                    [col.name]: e.currentTarget.value,
                  });
                }}
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
              onClose();
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
        <button aria-label="Close dialog" disabled={busy()}>
          close
        </button>
      </form>
    </Dialog>
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
  // Picker in ?d1-table= (deep-linkable); unknown values fall back below.
  const selectedTable = searchParam("d1-table", { default: "" });
  // Collaborator role for write UI (fail-closed until confirmed).
  const detail = appDetail(appId);
  const myRole = detail.data()?.myRole ?? null;
  const appName = detail.data()?.app.name ?? "";
  // Create/edit drawer state (table/schema resolve from the selection).
  // The drawer mounts per open and reports its close through onClose.
  const drawer = atom<null | {
    mode: "create" | "edit";
    row: Record<string, string> | null;
  }>(null);
  const current = tables.includes(selectedTable())
    ? selectedTable()
    : (tables[0] ?? "");
  const currentIndex = tables.indexOf(current);
  const { columns: currentColumns, rows: currentRows } =
    currentIndex === -1
      ? { columns: [], rows: [] }
      : parseTable(d1Data.rows[currentIndex] ?? "");
  const canWrite = myRole === "push" || myRole === "admin";
  const switchTable = (next: string) => {
    if (!tables.includes(next)) {
      return;
    }
    drawer.set(null);
    selectedTable.set(next);
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
                    switchTable(e.currentTarget.value);
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
        appName={appName}
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
