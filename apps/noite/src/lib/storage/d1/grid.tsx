//! The D1 data grid: a sticky header with sortable columns, a selection
//! column with a bulk-delete bar, truncated cells (see ./cells) and the
//! pager footer. Rows come from the server for exactly the URL query handed
//! in, so this component is mounted per query (`key` in ./panel).

import { atom } from "ilha";
import type { View } from "ilha";

import { errorMessage } from "../../errors";
import { d1Rows } from "../../resources";
import type { D1Cell, D1RowsQuery, D1TableSchema } from "../../runner";
import { d1DeleteRows } from "../../server/storage.server";
import { ChevronLeft, ChevronRight, Key } from "../../ui/icons";
import { isTimestampColumn, keyFor } from "../d1-values";
import { CellValue } from "./cells";
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
    <a
      class="link link-hover text-xs"
      href={`/apps/${appId}?t=${encodeURIComponent(action.tab)}&${action.param}=${encodeURIComponent(value)}`}
      onclick={(event) => {
        event.stopPropagation();
      }}
    >
      {action.label}
    </a>
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

export const RowsGrid = ({
  appId,
  databaseId,
  onChanged,
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
  onChanged: () => void;
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
  const resource = d1Rows(appId, databaseId, query);
  const selected = atom<Record<string, true>>({});
  const confirming = atom(false);
  const busy = atom(false);
  const failure = atom("");
  const data = resource.data();
  const loadError = resource.error();
  if (loadError && data === undefined) {
    return <p class="text-error m-0 p-4 text-sm">{errorMessage(loadError)}</p>;
  }
  if (!data) {
    return (
      <div class="flex flex-col gap-2 p-4">
        <span class="skeleton h-8 w-full" />
        <span class="skeleton h-6 w-full" />
        <span class="skeleton h-6 w-full" />
      </div>
    );
  }
  const schemaColumn = (name: string) =>
    schema.columns.find((column) => column.name === name);
  const selectable = schema.caps.delete;
  const selectedIndexes = Object.keys(selected());
  const allSelected =
    data.rows.length > 0 && selectedIndexes.length === data.rows.length;
  const bulkDelete = async () => {
    if (busy()) {
      return;
    }
    busy.set(true);
    try {
      const keys = selectedIndexes.map((index) =>
        keyFor(
          schema.columns,
          rowRecord(data.columns, data.rows[Number(index)] ?? [])
        )
      );
      const result = await d1DeleteRows({
        appId,
        databaseId,
        keys,
        table: data.table,
      });
      const deleted = result?.deleted ?? keys.length;
      failure.set("");
      selected.set({});
      confirming.set(false);
      onToast(`${deleted} row${deleted === 1 ? "" : "s"} deleted`);
      onChanged();
    } catch (error) {
      failure.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {selectedIndexes.length > 0 ? (
        <div class="bg-base-200 dark:bg-base-300/50 flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
          <span class="font-medium">{selectedIndexes.length} selected</span>
          {confirming() ? (
            <>
              <span class="text-error">
                Delete {selectedIndexes.length} row(s)? This cannot be undone.
              </span>
              <button
                type="button"
                class="btn btn-sm btn-error"
                disabled={busy()}
                onclick={() => {
                  void bulkDelete();
                }}
              >
                {busy() ? "Deleting…" : "Delete"}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => {
                  confirming.set(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onclick={() => {
                confirming.set(true);
              }}
            >
              Delete
            </button>
          )}
          <button
            type="button"
            class="btn btn-sm btn-ghost ml-auto"
            onclick={() => {
              selected.set({});
            }}
          >
            Clear
          </button>
        </div>
      ) : null}
      {failure() ? (
        <p class="text-error m-0 px-3 py-1 text-sm">{failure()}</p>
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
                        if (allSelected) {
                          selected.set({});
                          return;
                        }
                        const next: Record<string, true> = {};
                        for (const [index] of data.rows.entries()) {
                          next[String(index)] = true;
                        }
                        selected.set(next);
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
                          checked={selected()[String(index)] === true}
                          onchange={(event) => {
                            const next: Record<string, true> = {};
                            for (const [key] of Object.entries(selected())) {
                              if (key !== String(index)) {
                                next[key] = true;
                              }
                            }
                            if (event.currentTarget.checked) {
                              next[String(index)] = true;
                            }
                            selected.set(next);
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
};
