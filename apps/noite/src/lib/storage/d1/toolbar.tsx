//! The D1 editor toolbar: server-side row search, a filter popover, sort,
//! refresh and Insert. All state it shows comes from the URL query; applying
//! a control writes those params (see ./state).

import { atom } from "ilha";

import { collectRef, liveEl, newLiveRef } from "../../live-ref";
import type {
  D1Column,
  D1Filter,
  D1FilterOp,
  D1RowsQuery,
  D1TableCaps,
} from "../../runner";
import { ArrowUpDown, Filter, Plus, Refresh, Search, X } from "../../ui/icons";
import {
  encodeFilters,
  encodeSort,
  FILTER_OPS,
  FILTER_OP_LABELS,
  MAX_FILTERS,
} from "./state";

/** One filter's operator select. */
const OpSelect = ({
  onPick,
  op,
}: {
  onPick: (op: D1FilterOp) => void;
  op: D1FilterOp;
}) => (
  <select
    class="select select-sm"
    aria-label="Operator"
    value={op}
    onchange={(event) => {
      // SAFETY: the options are exactly FILTER_OPS.
      onPick(event.currentTarget.value as D1FilterOp);
    }}
  >
    {FILTER_OPS.map((candidate) => (
      <option key={candidate} value={candidate} selected={candidate === op}>
        {FILTER_OP_LABELS[candidate]}
      </option>
    ))}
  </select>
);

const FilterPopover = ({
  applied,
  columns,
  onApply,
}: {
  applied: D1Filter[];
  columns: D1Column[];
  onApply: (filters: D1Filter[]) => void;
}) => {
  const rows = atom<D1Filter[]>(applied);
  const details = atom.lazy(newLiveRef<HTMLDetailsElement>)();
  const close = () => {
    const element = liveEl(details);
    if (element) {
      element.open = false;
    }
  };
  const update = (index: number, patch: Partial<D1Filter>) => {
    rows.set(
      rows().map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  };
  return (
    <details
      class="dropdown"
      id="d1-filter-popover"
      ref={(el) => {
        collectRef(details, el);
      }}
    >
      <summary
        class="btn btn-sm btn-ghost gap-1"
        aria-label="Filter rows"
        title="Filter rows"
      >
        <Filter />
        <span class="hidden sm:inline">Filter</span>
        {applied.length > 0 ? (
          <span class="badge badge-sm">{applied.length}</span>
        ) : null}
      </summary>
      <div class="dropdown-content bg-base-100 dark:bg-base-200 border-base-300 rounded-box z-50 mt-1 w-[30rem] max-w-[92vw] border p-3 shadow-lg">
        <div class="flex flex-col gap-2">
          {rows().map((row, index) => (
            <div
              class="flex flex-wrap items-center gap-1"
              key={`${index}:${row.column}`}
            >
              <select
                class="select select-sm min-w-32 flex-1"
                aria-label="Filter column"
                value={row.column}
                onchange={(event) => {
                  update(index, { column: event.currentTarget.value });
                }}
              >
                {columns.map((column) => (
                  <option
                    key={column.name}
                    value={column.name}
                    selected={column.name === row.column}
                  >
                    {column.name}
                  </option>
                ))}
              </select>
              <OpSelect
                op={row.op}
                onPick={(op) => {
                  update(index, { op });
                }}
              />
              <input
                class="input input-sm min-w-24 flex-1"
                type="text"
                aria-label="Filter value"
                placeholder="value"
                disabled={row.op === "is_null" || row.op === "not_null"}
                value={row.value}
                oninput={(event) => {
                  update(index, { value: event.currentTarget.value });
                }}
              />
              <button
                type="button"
                class="btn btn-square btn-ghost btn-sm"
                aria-label="Remove filter"
                onclick={() => {
                  rows.set(rows().filter((_row, i) => i !== index));
                }}
              >
                <X />
              </button>
            </div>
          ))}
          {rows().length === 0 ? (
            <p class="m-0 text-sm opacity-60">No filters — every row shows.</p>
          ) : null}
        </div>
        <div class="border-base-300 mt-3 flex items-center justify-between border-t pt-3">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={applied.length === 0}
            onclick={() => {
              rows.set([]);
              onApply([]);
              close();
            }}
          >
            Clear
          </button>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={rows().length >= MAX_FILTERS || columns.length === 0}
              onclick={() => {
                rows.set([
                  ...rows(),
                  { column: columns[0]?.name ?? "", op: "eq", value: "" },
                ]);
              }}
            >
              <Plus />
              Add
            </button>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              onclick={() => {
                onApply(rows());
                close();
              }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </details>
  );
};

const SortPopover = ({
  applied,
  columns,
  onApply,
}: {
  applied: D1RowsQuery["sort"];
  columns: D1Column[];
  onApply: (sort: D1RowsQuery["sort"]) => void;
}) => {
  const column = atom(applied?.column ?? columns[0]?.name ?? "");
  const desc = atom(applied?.desc ?? false);
  const details = atom.lazy(newLiveRef<HTMLDetailsElement>)();
  const close = () => {
    const element = liveEl(details);
    if (element) {
      element.open = false;
    }
  };
  return (
    <details
      class="dropdown"
      id="d1-sort-popover"
      ref={(el) => {
        collectRef(details, el);
      }}
    >
      <summary
        class="btn btn-sm btn-ghost gap-1"
        aria-label="Sort rows"
        title="Sort rows"
      >
        <ArrowUpDown />
        <span class="hidden sm:inline">Sort</span>
        {applied ? (
          <span class="hidden text-xs opacity-70 sm:inline">
            {applied.column} {applied.desc ? "↓" : "↑"}
          </span>
        ) : null}
      </summary>
      <div class="dropdown-content bg-base-100 dark:bg-base-200 border-base-300 rounded-box z-50 mt-1 flex w-72 flex-col gap-3 border p-3 shadow-lg">
        <label class="flex flex-col gap-1 text-sm">
          Column
          <select
            class="select select-sm"
            value={column()}
            onchange={(event) => {
              column.set(event.currentTarget.value);
            }}
          >
            {columns.map((candidate) => (
              <option
                key={candidate.name}
                value={candidate.name}
                selected={candidate.name === column()}
              >
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <div class="join w-full">
          <button
            type="button"
            class={`btn btn-sm join-item flex-1 ${desc() ? "" : "btn-active"}`}
            aria-pressed={desc() ? "false" : "true"}
            onclick={() => {
              desc.set(false);
            }}
          >
            Ascending
          </button>
          <button
            type="button"
            class={`btn btn-sm join-item flex-1 ${desc() ? "btn-active" : ""}`}
            aria-pressed={desc() ? "true" : "false"}
            onclick={() => {
              desc.set(true);
            }}
          >
            Descending
          </button>
        </div>
        <div class="flex justify-between">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={applied === null}
            onclick={() => {
              onApply(null);
              close();
            }}
          >
            Clear
          </button>
          <button
            type="button"
            class="btn btn-sm btn-neutral"
            disabled={columns.length === 0}
            onclick={() => {
              onApply({ column: column(), desc: desc() });
              close();
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </details>
  );
};

export const TableToolbar = ({
  applied,
  caps,
  columns,
  onApplyFilters,
  onApplySort,
  onInsert,
  onRefresh,
  onSearch,
}: {
  applied: D1RowsQuery;
  caps: D1TableCaps;
  /** Columns the table can be filtered/sorted on (redacted ones removed). */
  columns: D1Column[];
  onApplyFilters: (filters: D1Filter[]) => void;
  onApplySort: (sort: D1RowsQuery["sort"]) => void;
  onInsert: () => void;
  onRefresh: () => void;
  onSearch: (needle: string) => void;
}) => {
  const typed = atom(applied.search);
  const timer = atom.lazy(() => ({ id: 0 }))();
  return (
    <div class="border-base-300 flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <label class="input input-sm w-56 max-w-full">
        <Search class="h-4 w-4 opacity-50" />
        <input
          type="search"
          aria-label="Search rows"
          placeholder="Search rows…"
          value={typed()}
          oninput={(event) => {
            const { value } = event.currentTarget;
            typed.set(value);
            // Debounce: every commit changes the rows resource key, so one
            // request per keystroke would remount the grid each time.
            window.clearTimeout(timer.id);
            timer.id = window.setTimeout(() => {
              onSearch(value);
            }, 300);
          }}
        />
      </label>
      <FilterPopover
        key={`filters:${encodeFilters(applied.filters)}`}
        applied={applied.filters}
        columns={columns}
        onApply={onApplyFilters}
      />
      <SortPopover
        key={`sort:${encodeSort(applied.sort)}`}
        applied={applied.sort}
        columns={columns}
        onApply={onApplySort}
      />
      <button
        type="button"
        class="btn btn-square btn-ghost btn-sm"
        aria-label="Refresh rows"
        title="Refresh"
        onclick={() => {
          onRefresh();
        }}
      >
        <Refresh />
      </button>
      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="btn btn-sm btn-neutral"
          disabled={!caps.insert}
          title={
            caps.insert
              ? "Insert a row"
              : "Insert is not allowed for this table"
          }
          onclick={() => {
            onInsert();
          }}
        >
          <Plus />
          Insert
        </button>
      </div>
    </div>
  );
};
