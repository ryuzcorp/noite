//! The D1 table editor (Supabase-style): table rail, toolbar, server-paged
//! grid, Definition view, row editor and toasts. Every query the grid runs
//! comes from validated URL params (see ./state), so a view is deep-linkable
//! and a write can invalidate exactly what it changed.

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import { resourceValue, resourceError } from "../../resource";
import { d1Schema, d1Tables, invalidateD1 } from "../../resources";
import type { D1Cell, D1Column, D1Filter, D1RowsQuery } from "../../runner";
import { searchParam } from "../../search-param";
import { Toaster, useToasts } from "../shared";
import { TableDefinition } from "./definition";
import { RowsGrid } from "./grid";
import { nextEditorQuery } from "./query";
import type { EditorQuery, EditorQueryEvent } from "./query";
import { RowEditor } from "./row-editor";
import { rowKey } from "./selection";
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

/** The editor's URL-backed state (one value, see ./query). */
type UrlState = EditorQuery;

/** Writes for that state. */
interface UrlSetters {
  setFilters: (filters: D1Filter[]) => void;
  setPage: (page: number) => void;
  setSearch: (needle: string) => void;
  setSize: (size: number) => void;
  setSort: (sort: D1RowsQuery["sort"]) => void;
  setView: (view: D1View) => void;
}

/** The row editor's remount key: closed, insert, or the record's own key. */
const editorKeyOf = (
  columns: D1Column[],
  open: null | { row: Record<string, D1Cell> | null }
): string => {
  if (open === null) {
    return "closed";
  }

  if (open.row === null) {
    return "insert";
  }

  return `edit:${rowKey(columns, open.row)}`;
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
  const schema = resourceValue(schemaRes.state());
  const loadError = resourceError(schemaRes.state());

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
    filters: validFilters([...state.filters], schema),
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

  // Remount key for the row editor: a different *record* must get fresh
  // drafts. Keyed by the row's own key (never the whole row's text, which
  // makes two distinct rows with equal values collide).
  const openKey = editorKeyOf(schema.columns, open);

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

  const tablesState = tablesRes.state();
  const tablesData = resourceValue(tablesState);
  const loadError = resourceError(tablesState);
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

  /** The one writer for the URL query: every transition goes through
   * `nextEditorQuery`, so the cross-param invariants (page reset, table
   * clearing, FK jump) have a single definition. */
  const apply = (event: EditorQueryEvent) => {
    const next = nextEditorQuery(state, event);
    filtersRaw.set(encodeFilters([...next.filters]));
    page.set(next.page);
    size.set(next.pageSize);
    search.set(next.search);
    sortRaw.set(encodeSort(next.sort));
    view.set(next.view);
  };

  const setters: UrlSetters = {
    setFilters: (filters) => {
      apply({ filters, kind: "filters" });
    },
    setPage: (next) => {
      apply({ kind: "page", page: next });
    },
    setSearch: (needle) => {
      apply({ kind: "search", search: needle });
    },
    setSize: (next) => {
      apply({ kind: "size", size: next });
    },
    setSort: (sort) => {
      apply({ kind: "sort", sort });
    },
    setView: (next) => {
      apply({ kind: "view", view: next });
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
      apply({
        column: target.column,
        kind: "fkJump",
        table: target.table,
        value: target.value,
      });
    },
    switchTable: (next: string) => {
      tableParam.set(next);
      apply({ kind: "table" });
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
