//! The D1 table editor (Supabase-style): table rail, toolbar, server-paged
//! grid, Definition view, row editor and toasts. Every query the grid runs
//! comes from validated URL params (see ./state), so a view is deep-linkable
//! and a write can invalidate exactly what it changed.

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import { d1Schema, d1Tables, invalidateD1 } from "../../resources";
import type { D1Cell, D1Filter, D1RowsQuery } from "../../runner";
import { searchParam } from "../../search-param";
import { Toaster, useToasts } from "../shared";
import { TableDefinition } from "./definition";
import { RowsGrid } from "./grid";
import { RowEditor } from "./row-editor";
import { TableSelect, TableSidebar } from "./sidebar";
import {
  DEFAULT_PAGE_SIZE,
  decodeFilters,
  decodeSort,
  encodeFilters,
  encodeSort,
  toPageIndex,
  toPageSize,
  toView,
  validFilters,
  validSort,
  VIEW_LABELS,
  VIEWS,
} from "./state";
import type { D1View } from "./state";
import { TableToolbar } from "./toolbar";

/** The editor's URL-backed state, read once per render in D1Editor. */
interface UrlState {
  filters: D1Filter[];
  page: number;
  pageSize: number;
  search: string;
  sort: D1RowsQuery["sort"];
  view: D1View;
}

/** Writes for that state. */
interface UrlSetters {
  setFilters: (filters: D1Filter[]) => void;
  setPage: (page: number) => void;
  setSearch: (needle: string) => void;
  setSize: (size: number) => void;
  setSort: (sort: D1RowsQuery["sort"]) => void;
  setView: (view: D1View) => void;
}

/** Remount key for the row editor: a different row must get fresh drafts. */
const editorKey = (
  open: null | { row: Record<string, D1Cell> | null }
): string => {
  if (open === null) {
    return "closed";
  }
  if (open.row === null) {
    return "insert";
  }
  return `edit:${JSON.stringify(open.row)}`;
};

const ViewSwitch = ({
  onPick,
  view,
}: {
  onPick: (view: D1View) => void;
  view: D1View;
}) => (
  <div class="join" role="group" aria-label="View">
    {VIEWS.map((candidate) => (
      <button
        key={candidate}
        type="button"
        class={`btn btn-sm join-item ${view === candidate ? "btn-active" : ""}`}
        aria-pressed={view === candidate ? "true" : "false"}
        onclick={() => {
          onPick(candidate);
        }}
      >
        {VIEW_LABELS[candidate]}
      </button>
    ))}
  </div>
);

/** One table's workspace: schema, toolbar, grid/definition, pager, editor.
 * Keyed by table name in D1Editor, so the schema resource stays bound to one
 * table for the life of the fiber. */
const TableWorkspace = ({
  appId,
  databaseId,
  nav,
  onToast,
  setters,
  state,
  table,
}: {
  appId: string;
  databaseId: string;
  nav: {
    openForeignKey: (target: {
      column: string;
      table: string;
      value: D1Cell;
    }) => void;
  };
  onToast: (text: string) => void;
  setters: UrlSetters;
  state: UrlState;
  table: string;
}) => {
  const schemaRes = d1Schema(appId, databaseId, table);
  const editor = atom<null | { row: Record<string, D1Cell> | null }>(null);
  const schema = schemaRes.data();
  const loadError = schemaRes.error();
  if (!schema) {
    if (loadError) {
      return (
        <p class="text-error m-0 p-4 text-sm">{errorMessage(loadError)}</p>
      );
    }
    return (
      <div class="flex min-h-0 flex-1 flex-col gap-2 p-4">
        <span class="skeleton h-8 w-full" />
        <span class="skeleton h-6 w-full" />
        <span class="skeleton h-6 w-full" />
      </div>
    );
  }
  const sort = validSort(state.sort, schema);
  const query: D1RowsQuery = {
    filters: validFilters(state.filters, schema),
    page: state.page,
    pageSize: state.pageSize,
    search: state.search,
    sort,
    table,
  };
  const refresh = () => {
    invalidateD1(appId, databaseId);
  };
  const cycleSort = (column: string) => {
    if (sort === null || sort.column !== column) {
      setters.setSort({ column, desc: false });
      return;
    }
    setters.setSort(sort.desc ? null : { column, desc: true });
  };
  const viewSlot = <ViewSwitch onPick={setters.setView} view={state.view} />;
  const open = editor();
  const openKey = editorKey(open);
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {state.view === "data" ? (
        <TableToolbar
          applied={query}
          caps={schema.caps}
          columns={schema.columns.filter(
            (column) => !schema.redacted.includes(column.name)
          )}
          onApplyFilters={setters.setFilters}
          onApplySort={setters.setSort}
          onInsert={() => {
            editor.set({ row: null });
          }}
          onRefresh={refresh}
          onSearch={setters.setSearch}
        />
      ) : null}
      {state.view === "definition" ? (
        <TableDefinition schema={schema} />
      ) : (
        <RowsGrid
          key={JSON.stringify(query)}
          appId={appId}
          databaseId={databaseId}
          onChanged={refresh}
          onOpenRow={(row) => {
            editor.set({ row });
          }}
          onPage={setters.setPage}
          onSize={setters.setSize}
          onSort={cycleSort}
          onToast={onToast}
          query={query}
          schema={schema}
          viewSlot={viewSlot}
        />
      )}
      {state.view === "definition" ? (
        <div class="border-base-300 flex items-center justify-end border-t px-3 py-2">
          {viewSlot}
        </div>
      ) : null}
      {open === null ? null : (
        <RowEditor
          key={openKey}
          appId={appId}
          databaseId={databaseId}
          onClose={() => {
            editor.set(null);
          }}
          onOpenFk={nav.openForeignKey}
          onSaved={refresh}
          onToast={onToast}
          row={open.row}
          schema={schema}
        />
      )}
    </div>
  );
};

export const D1Editor = ({
  appId,
  appName,
  databaseId,
}: {
  appId: string;
  appName: string;
  databaseId: string;
}) => {
  const tablesRes = d1Tables(appId, databaseId);
  const tableParam = searchParam("table", { default: "" });
  const page = searchParam("page", { default: 0, parse: toPageIndex });
  const size = searchParam("size", {
    default: DEFAULT_PAGE_SIZE,
    parse: toPageSize,
  });
  const search = searchParam("q", { default: "" });
  const sortRaw = searchParam("sort", { default: "" });
  const filtersRaw = searchParam("f", { default: "" });
  const view = searchParam<D1View>("view", { default: "data", parse: toView });

  const { notify: onToast, toasts } = useToasts();

  const tablesData = tablesRes.data();
  const loadError = tablesRes.error();
  const tables = tablesData?.tables ?? [];
  const current =
    tables.find((candidate) => candidate.name === tableParam()) ?? tables[0];
  const state: UrlState = {
    filters: decodeFilters(filtersRaw()),
    page: page(),
    pageSize: size(),
    search: search(),
    sort: decodeSort(sortRaw()),
    view: view(),
  };
  const setters: UrlSetters = {
    setFilters: (next) => {
      filtersRaw.set(encodeFilters(next));
      page.set(0);
    },
    setPage: (next) => {
      page.set(Math.max(next, 0));
    },
    setSearch: (needle) => {
      search.set(needle);
      page.set(0);
    },
    setSize: (next) => {
      size.set(next);
      page.set(0);
    },
    setSort: (next) => {
      sortRaw.set(encodeSort(next));
      page.set(0);
    },
    setView: (next) => {
      view.set(next);
    },
  };
  const nav = {
    /** Jump to the table a foreign key points at, filtered to that row. */
    openForeignKey: (target: {
      column: string;
      table: string;
      value: D1Cell;
    }) => {
      tableParam.set(target.table);
      filtersRaw.set(
        target.value === null
          ? ""
          : encodeFilters([
              { column: target.column, op: "eq", value: target.value },
            ])
      );
      sortRaw.set("");
      search.set("");
      page.set(0);
      view.set("data");
    },
    switchTable: (next: string) => {
      tableParam.set(next);
      filtersRaw.set("");
      sortRaw.set("");
      search.set("");
      page.set(0);
    },
  };
  if (!tablesData) {
    if (loadError) {
      return (
        <p class="text-error m-0 p-4 text-sm">{errorMessage(loadError)}</p>
      );
    }
    return (
      <div class="flex min-h-0 flex-1 flex-col gap-2 p-4">
        <span class="skeleton h-8 w-full" />
        <span class="skeleton h-32 w-full" />
      </div>
    );
  }
  if (current === undefined) {
    return (
      <p class="m-0 p-4 text-sm opacity-60">This database has no tables yet.</p>
    );
  }
  return (
    <div class="flex h-full min-h-0 w-full overflow-hidden">
      <TableSidebar
        appId={appId}
        appName={appName}
        current={current.name}
        databaseId={databaseId}
        onSelect={nav.switchTable}
        tables={tables}
      />
      <div class="flex min-w-0 flex-1 flex-col">
        <TableSelect
          appId={appId}
          appName={appName}
          current={current.name}
          databaseId={databaseId}
          onSelect={nav.switchTable}
          tables={tables}
        />
        <div class="border-base-300 overflow-x-auto border-b">
          <div role="tablist" class="tabs tabs-border w-max flex-nowrap">
            <button
              type="button"
              role="tab"
              aria-selected="true"
              class="tab tab-active gap-2 whitespace-nowrap"
            >
              <span class="truncate">{current.name}</span>
              <span class="badge badge-sm tabular-nums">
                {current.rowCount}
              </span>
            </button>
          </div>
        </div>
        <TableWorkspace
          key={current.name}
          appId={appId}
          databaseId={databaseId}
          nav={nav}
          onToast={onToast}
          setters={setters}
          state={state}
          table={current.name}
        />
      </div>
      <Toaster toasts={toasts()} />
    </div>
  );
};
