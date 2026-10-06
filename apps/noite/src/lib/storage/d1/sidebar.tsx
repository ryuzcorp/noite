//! The D1 editor's left rail: database identity, a table filter, and the
//! table list with row counts and a lock for read-only tables. Collapses to
//! a `<select>` on small screens (see `TableSelect`).

import { atom } from "ilha";

import {
  ArrowLeft,
  Database,
  Lock,
  Search,
  Table as TableIcon,
} from "../../icons";
import type { D1TableCaps, D1TableInfo } from "../../runner";

/** A table the caller cannot write at all (every capability false). */
const isReadOnly = (caps: D1TableCaps | undefined): boolean =>
  caps !== undefined && !caps.insert && !caps.update && !caps.delete;

const rowCountLabel = (count: number): string =>
  count === 1 ? "1 row" : `${count} rows`;

export const TableSidebar = ({
  appId,
  appName,
  current,
  databaseId,
  onSelect,
  tables,
}: {
  appId: string;
  appName: string;
  current: string;
  databaseId: string;
  onSelect: (table: string) => void;
  tables: D1TableInfo[];
}) => {
  const query = atom("");
  const needle = query().trim().toLowerCase();
  const visible =
    needle === ""
      ? tables
      : tables.filter((table) => table.name.toLowerCase().includes(needle));
  return (
    <aside class="bg-base-100 dark:bg-base-200 border-base-300 hidden w-64 shrink-0 flex-col border-r md:flex">
      <div class="border-base-300 flex flex-col gap-1 border-b p-3">
        <a
          class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
          href={`/apps/${appId}`}
        >
          <ArrowLeft />
          {appName || "App"}
        </a>
        <div class="flex items-center gap-2">
          <Database class="h-4 w-4 shrink-0 opacity-60" />
          <span class="truncate font-semibold" title={databaseId}>
            {databaseId}
          </span>
          <span class="badge badge-sm">D1</span>
        </div>
      </div>
      <div class="px-3 pt-3 pb-1">
        <label class="input input-sm w-full" for="d1-table-search">
          <Search class="h-4 w-4 opacity-50" />
          <input
            id="d1-table-search"
            type="search"
            aria-label="Search tables"
            placeholder="Search tables"
            value={query()}
            oninput={(event) => {
              query.set(event.currentTarget.value);
            }}
          />
        </label>
      </div>
      <nav class="flex-1 overflow-y-auto p-2" aria-label="Tables">
        <ul class="menu w-full gap-0.5 p-0">
          {visible.map((table) => (
            <li key={table.name}>
              <button
                type="button"
                class={table.name === current ? "menu-active gap-2" : "gap-2"}
                aria-current={table.name === current ? "true" : undefined}
                onclick={() => {
                  onSelect(table.name);
                }}
              >
                <TableIcon class="h-4 w-4 shrink-0 opacity-60" />
                <span class="min-w-0 flex-1 truncate text-left">
                  {table.name}
                </span>
                {isReadOnly(table.caps) ? (
                  <Lock class="h-3.5 w-3.5 shrink-0 opacity-50" />
                ) : null}
                <span class="shrink-0 text-xs tabular-nums opacity-50">
                  {table.rowCount}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {visible.length === 0 ? (
          <p class="px-2 text-sm opacity-60">No tables match.</p>
        ) : null}
      </nav>
      <div class="border-base-300 border-t px-3 py-2 text-xs opacity-50">
        {tables.length} table{tables.length === 1 ? "" : "s"}
      </div>
    </aside>
  );
};

/** The sidebar's mobile stand-in: one select above the grid. */
export const TableSelect = ({
  appId,
  appName,
  current,
  databaseId,
  onSelect,
  tables,
}: {
  appId: string;
  appName: string;
  current: string;
  databaseId: string;
  onSelect: (table: string) => void;
  tables: D1TableInfo[];
}) => (
  <div class="border-base-300 flex flex-wrap items-center gap-2 border-b px-3 py-2 md:hidden">
    <a
      class="link link-hover inline-flex items-center gap-1 text-sm opacity-70"
      href={`/apps/${appId}`}
    >
      <ArrowLeft />
      {appName || "App"}
    </a>
    <span class="truncate text-sm font-semibold">{databaseId}</span>
    <span class="badge badge-sm">D1</span>
    <label class="ml-auto flex items-center gap-2 text-sm">
      <span class="sr-only">Table</span>
      <select
        class="select select-sm"
        aria-label="Table"
        onchange={(event) => {
          onSelect(event.currentTarget.value);
        }}
      >
        {tables.map((table) => (
          <option
            key={table.name}
            value={table.name}
            selected={table.name === current}
          >
            {table.name} ({rowCountLabel(table.rowCount)})
          </option>
        ))}
      </select>
    </label>
  </div>
);
