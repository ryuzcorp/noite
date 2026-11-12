//! The D1 data grid: a sticky header with sortable columns, a selection
//! column with a bulk-delete bar, truncated cells (see ./cells) and the
//! pager footer. Rows come from the server for exactly the URL query handed
//! in, so this component is mounted per query (`key` in ./panel).
//!
//! The selection is an `@ilha/model` island (./selection): row keys, not row
//! indices, so a reload or a reordering cannot remap the selection onto other
//! records; the armed confirmation is part of the same value, so the delete
//! payload is always the set the user confirmed.

import { defineApp } from "@ilha/model";
import { Link } from "@ilha/void";
import { Data } from "effect";
import * as Effect from "effect/Effect";
import type { View } from "ilha";

import { api } from "../../api";
import { errorMessage, operationMessage } from "../../errors";
import { islandProps } from "../../island";
import { d1Rows, invalidateD1 } from "../../resources";
import type { D1Cell, D1Rows, D1RowsQuery, D1TableSchema } from "../../runner";
import { ChevronLeft, ChevronRight, Key } from "../../ui/icons";
import { isTimestampColumn } from "../d1-values";
import { CellValue } from "./cells";
import {
  keyFromRowKey,
  nextSelection,
  rowKey,
  Selection,
  visibleSelection,
} from "./selection";
import type { GridSelection } from "./selection";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, pageCount } from "./state";

const rowRecord = (columns: string[], cells: D1Cell[]) => {
  const record: Record<string, D1Cell> = {};

  for (const [index, name] of columns.entries()) {
    record[name] = cells[index] ?? null;
  }

  return record;
};

/** The header's sort mark for one column (null when it is not the sort
 * column). */
const sortMark = (sort: D1RowsQuery["sort"], column: string): string | null => {
  if (sort === null || sort.column !== column) {
    return null;
  }

  return sort.desc ? "▼" : "▲";
};

/** The per-row link to the admin action that owns the record (control D1
 * only), prefilling that tab's search from the row. */
const RowActionLink = ({
  action,
  appId,
  record,
}: {
  action: NonNullable<D1TableSchema["rowAction"]>;
  appId: string;
  record: Record<string, D1Cell>;
}) => {
  const value = record[action.column] ?? "";

  if (value === "") {
    return null;
  }

  return (
    <Link
      class="link link-hover text-xs"
      href={`/apps/${appId}?t=${encodeURIComponent(action.tab)}&${action.param}=${encodeURIComponent(value)}`}
      onclick={(event) => {
        event.stopPropagation();
      }}
    >
      {action.label}
    </Link>
  );
};

/** The pager: `Page [n] of N`, prev/next, page size and the record count. */
const Pager = ({
  onPage,
  onSize,
  page,
  pageSize,
  total,
}: {
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  page: number;
  pageSize: number;
  total: number;
}) => {
  const pages = pageCount(total, pageSize);

  return (
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <label class="flex items-center gap-1">
        <span class="opacity-60">Page</span>
        <input
          class="input input-sm w-16 text-center"
          type="number"
          min="1"
          max={pages}
          aria-label="Page"
          value={String(page + 1)}
          onchange={(event) => {
            const next = Math.trunc(Number(event.currentTarget.value)) || 1;
            onPage(Math.min(Math.max(next - 1, 0), pages - 1));
          }}
        />
        <span class="opacity-60">of {pages}</span>
      </label>
      <button
        type="button"
        class="btn btn-square btn-ghost btn-sm"
        aria-label="Previous page"
        disabled={page === 0}
        onclick={() => {
          onPage(Math.max(page - 1, 0));
        }}
      >
        <ChevronLeft />
      </button>
      <button
        type="button"
        class="btn btn-square btn-ghost btn-sm"
        aria-label="Next page"
        disabled={page + 1 >= pages}
        onclick={() => {
          onPage(Math.min(page + 1, pages - 1));
        }}
      >
        <ChevronRight />
      </button>
      <label class="flex items-center gap-1">
        <span class="sr-only">Rows per page</span>
        <select
          class="select select-sm"
          aria-label="Rows per page"
          onchange={(event) => {
            onSize(Number(event.currentTarget.value) || DEFAULT_PAGE_SIZE);
          }}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size} selected={size === pageSize}>
              {size} / page
            </option>
          ))}
        </select>
      </label>
      <span class="opacity-60">
        {total} record{total === 1 ? "" : "s"}
      </span>
    </div>
  );
};

/** The grid island's inputs: the listing the parent already holds, the row
 * actions, and the pager writes. The parent keeps the resource (and the
 * skeleton/error paint); the island owns only the selection machine. */
interface GridInputs {
  appId: string;
  databaseId: string;
  data: D1Rows;
  onOpenRow: (row: Record<string, D1Cell>) => void;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  onSort: (column: string) => void;
  onToast: (text: string) => void;
  query: D1RowsQuery;
  schema: D1TableSchema;
  viewSlot: View;
}

const Props = islandProps<GridInputs>("D1 grid");

type Message = Data.TaggedEnum<{
  Toggled: { readonly key: string };
  ToggledAll: { readonly keys: readonly string[] };
  Cleared: Record<never, never>;
  Armed: Record<never, never>;
  Cancelled: Record<never, never>;
  DeleteRequested: {
    readonly appId: string;
    readonly databaseId: string;
    readonly keys: readonly string[];
    readonly notify: (text: string) => void;
    readonly table: string;
  };
  Deleted: { readonly count: number };
  Failed: { readonly error: string };
}>;

const Msg = Data.taggedEnum<Message>();

/** Whether two key sets are the same selection (order-insensitive). */
const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key) => b.includes(key));

const deleteRows = ({
  appId,
  databaseId,
  keys,
  notify,
  table,
}: Extract<Message, { _tag: "DeleteRequested" }>) =>
  Effect.tryPromise({
    catch: (error) => operationMessage("Deleting the rows failed", error),
    try: () =>
      api<{ deleted: number; ok: boolean }>("/api/storage/d1DeleteRows", {
        appId,
        databaseId,
        // Selection keys are the serialized `keyFor` identity: the wire wants
        // the key object back.
        keys: keys.map(keyFromRowKey),
        table,
      }),
  }).pipe(
    Effect.match({
      onFailure: (error) => Msg.Failed({ error }),
      onSuccess: (result) => {
        const deleted = result?.deleted ?? keys.length;
        invalidateD1(appId, databaseId);
        notify(`${deleted} row${deleted === 1 ? "" : "s"} deleted`);

        return Msg.Deleted({ count: deleted });
      },
    })
  );

const GridIsland = defineApp({
  init: () => ({ model: Selection.Idle() }),
  name: "D1Grid",
  update: (model: GridSelection, message: Message) =>
    Msg.$match(message, {
      Armed: () => ({ model: nextSelection(model, { kind: "arm" }) }),
      Cancelled: () => ({ model: nextSelection(model, { kind: "cancel" }) }),
      Cleared: () => ({ model: nextSelection(model, { kind: "clear" }) }),
      DeleteRequested: (input) => {
        // The payload must be exactly the set the confirmation was armed for;
        // a listing change between arming and clicking sends nothing.
        const armed =
          model._tag === "Confirm" && sameKeys(model.keys, input.keys);

        const confirmed = nextSelection(model, { kind: "confirm" });

        if (!(armed && confirmed._tag === "Deleting")) {
          return { model: nextSelection(model, { kind: "cancel" }) };
        }

        return { cmd: deleteRows(input), model: confirmed };
      },
      Deleted: () => ({ model: nextSelection(model, { kind: "deleted" }) }),
      Failed: ({ error }) => ({
        model: nextSelection(model, { error, kind: "failed" }),
      }),
      Toggled: ({ key }) => ({
        model: nextSelection(model, { key, kind: "toggle" }),
      }),
      ToggledAll: ({ keys }) => ({
        model: nextSelection(model, { keys, kind: "toggleAll" }),
      }),
    }),
  view: (model: GridSelection, dispatch) => {
    const {
      appId,
      databaseId,
      data,
      onOpenRow,
      onPage,
      onSize,
      onSort,
      onToast,
      query,
      schema,
      viewSlot,
    } = Props.read();

    const schemaColumn = (name: string) =>
      schema.columns.find((column) => column.name === name);

    const selectable = schema.caps.delete;

    const keys = data.rows.map((cells) =>
      rowKey(schema.columns, rowRecord(data.columns, cells))
    );

    const selected = visibleSelection(model, keys);
    const allSelected = keys.length > 0 && selected.length === keys.length;

    // The confirmation belongs to the key set it was armed for: a listing
    // change (or a toggle) shows the plain Delete button again.
    const armed =
      (model._tag === "Confirm" || model._tag === "Deleting") &&
      sameKeys(model.keys, selected);

    return (
      <div class="flex min-h-0 flex-1 flex-col">
        {selected.length > 0 ? (
          <div class="bg-base-200 dark:bg-base-300/50 flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
            <span class="font-medium">{selected.length} selected</span>
            {/* One persistent Delete button: the first click arms the delete
                (./selection's `Confirm`), the second confirms it. Keeping the
                same node and box is what makes the two clicks deterministic
                for the e2e lane. */}
            <button
              type="button"
              class="btn btn-sm btn-error"
              disabled={model._tag === "Deleting"}
              onclick={() => {
                if (armed) {
                  dispatch(
                    Msg.DeleteRequested({
                      appId,
                      databaseId,
                      keys: selected,
                      notify: onToast,
                      table: data.table,
                    })
                  );

                  return;
                }

                dispatch(Msg.Armed());
              }}
            >
              {model._tag === "Deleting" ? "Deleting…" : "Delete"}
            </button>
            {armed ? (
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={model._tag === "Deleting"}
                onclick={() => {
                  dispatch(Msg.Cancelled());
                }}
              >
                Cancel
              </button>
            ) : null}
            {armed ? (
              <span class="text-error">
                Delete {selected.length} row(s)? This cannot be undone.
              </span>
            ) : null}
            <button
              type="button"
              class="btn btn-sm btn-ghost ml-auto"
              disabled={model._tag === "Deleting"}
              onclick={() => {
                dispatch(Msg.Cleared());
              }}
            >
              Clear
            </button>
          </div>
        ) : null}
        {model._tag === "Failed" ? (
          <p class="text-error m-0 px-3 py-1 text-sm">{model.error}</p>
        ) : null}
        <div class="min-h-0 flex-1 overflow-auto">
          {data.rows.length === 0 ? (
            <p class="m-0 p-4 text-sm opacity-60">
              {data.total === 0
                ? "This table has no rows."
                : "No rows match the current filters."}
            </p>
          ) : (
            <table class="table-sm table-pin-rows table w-full">
              <thead>
                <tr>
                  {selectable ? (
                    <th class="w-10">
                      <input
                        class="checkbox checkbox-sm"
                        type="checkbox"
                        aria-label="Select all rows on this page"
                        checked={allSelected}
                        onchange={() => {
                          dispatch(Msg.ToggledAll({ keys }));
                        }}
                      />
                    </th>
                  ) : null}
                  {data.columns.map((name) => {
                    const column = schemaColumn(name);
                    const mark = sortMark(query.sort, name);

                    return (
                      <th key={name} class="whitespace-nowrap">
                        <button
                          type="button"
                          class="inline-flex items-center gap-1 font-semibold"
                          title={`Sort by ${name}`}
                          onclick={() => {
                            onSort(name);
                          }}
                        >
                          {column !== undefined && column.pk > 0 ? (
                            <Key class="h-3.5 w-3.5 opacity-60" />
                          ) : null}
                          {name}
                          <span class="text-xs font-normal opacity-50">
                            {column?.type ?? ""}
                          </span>
                          {mark === null ? null : (
                            <span aria-hidden="true">{mark}</span>
                          )}
                        </button>
                      </th>
                    );
                  })}
                  {schema.rowAction === null ? null : <th class="w-32" />}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((cells, index) => {
                  const record = rowRecord(data.columns, cells);
                  const key = keys[index] ?? "";

                  return (
                    <tr
                      key={String(index)}
                      class="hover cursor-pointer"
                      onclick={() => {
                        onOpenRow(record);
                      }}
                    >
                      {selectable ? (
                        <td
                          onclick={(event) => {
                            event.stopPropagation();
                          }}
                        >
                          <input
                            class="checkbox checkbox-sm"
                            type="checkbox"
                            aria-label={`Select row ${index + 1}`}
                            checked={selected.includes(key)}
                            onchange={(event) => {
                              if (event.currentTarget.checked) {
                                dispatch(Msg.Toggled({ key }));

                                return;
                              }

                              dispatch(Msg.Toggled({ key }));
                            }}
                          />
                        </td>
                      ) : null}
                      {data.columns.map((name, columnIndex) => {
                        const column = schemaColumn(name);

                        return (
                          <td key={name} class="align-middle">
                            <CellValue
                              cell={cells[columnIndex] ?? null}
                              columnName={name}
                              columnType={column?.type ?? ""}
                              redacted={schema.redacted.includes(name)}
                              timestamp={isTimestampColumn(
                                name,
                                column?.type ?? ""
                              )}
                            />
                          </td>
                        );
                      })}
                      {schema.rowAction === null ? null : (
                        <td class="whitespace-nowrap">
                          <RowActionLink
                            appId={appId}
                            action={schema.rowAction}
                            record={record}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div class="border-base-300 flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
          <Pager
            onPage={onPage}
            onSize={onSize}
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
          />
          {viewSlot}
        </div>
      </div>
    );
  },
});

const Island = Props.wrap(GridIsland);

/** The grid body: reads the listing resource (one `ResourceState`) and mounts
 * the selection island once there is something to show. */
export const RowsGrid = ({
  appId,
  databaseId,
  onOpenRow,
  onPage,
  onSize,
  onSort,
  onToast,
  query,
  schema,
  viewSlot,
}: {
  appId: string;
  databaseId: string;
  onOpenRow: (row: Record<string, D1Cell>) => void;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  onSort: (column: string) => void;
  onToast: (text: string) => void;
  query: D1RowsQuery;
  schema: D1TableSchema;
  viewSlot: View;
}) => {
  // Mounted per query (`key` in ./panel): the resource key must be fixed for
  // the life of a fiber, so a new page/sort/filter remounts this component.
  const state = d1Rows(appId, databaseId, query).state();
  const data = state._tag === "Loading" ? undefined : state.value;

  if (data === undefined) {
    if (state._tag === "Failed") {
      return (
        <p class="text-error m-0 p-4 text-sm">{errorMessage(state.error)}</p>
      );
    }

    return (
      <div class="flex flex-col gap-2 p-4">
        <span class="skeleton h-8 w-full" />
        <span class="skeleton h-6 w-full" />
        <span class="skeleton h-6 w-full" />
      </div>
    );
  }

  return (
    <>
      {state._tag === "Failed" ? (
        <p class="text-error m-0 px-3 py-1 text-sm" role="alert">
          {errorMessage(state.error)} — showing the last loaded rows.
        </p>
      ) : null}
      <Island
        appId={appId}
        data={data}
        databaseId={databaseId}
        onOpenRow={onOpenRow}
        onPage={onPage}
        onSize={onSize}
        onSort={onSort}
        onToast={onToast}
        query={query}
        schema={schema}
        viewSlot={viewSlot}
      />
    </>
  );
};
