//! URL state for the D1 table editor. Everything the grid renders lives in
//! query params — `table`, `page`, `size`, `sort` (`col:asc|desc`), `f`
//! (filters, compact encoding), `q` (search), `view` (data|definition) — so
//! a filtered, sorted page is deep-linkable and the serialized query doubles
//! as the rows resource key.

import type {
  D1Filter,
  D1FilterOp,
  D1RowsQuery,
  D1TableSchema,
} from "../../runner";

export const PAGE_SIZES = [25, 50, 100] as const;

export const DEFAULT_PAGE_SIZE = 25;

/** The server refuses more than 10 filters; the popover stops adding here. */
export const MAX_FILTERS = 10;

export const FILTER_OPS: readonly D1FilterOp[] = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "like",
  "is_null",
  "not_null",
];

export const FILTER_OP_LABELS: Record<D1FilterOp, string> = {
  eq: "=",
  gt: ">",
  gte: "≥",
  is_null: "is NULL",
  like: "like",
  lt: "<",
  lte: "≤",
  neq: "≠",
  not_null: "is not NULL",
};

export const VIEWS = ["data", "definition"] as const;
export type D1View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<D1View, string> = {
  data: "Data",
  definition: "Definition",
};

/** Compact filter encoding: `col~op~value` triples joined by `|`, each field
 * percent-encoded so a value may contain the separators. The router wraps the
 * whole thing in URLSearchParams, so this only has to round-trip exactly. */
const FILTER_SEP = "|";
const FIELD_SEP = "~";

export const encodeFilters = (filters: readonly D1Filter[]): string => {
  const parts: string[] = [];
  for (const filter of filters) {
    parts.push(
      [filter.column, filter.op, filter.value]
        .map(encodeURIComponent)
        .join(FIELD_SEP)
    );
  }
  return parts.join(FILTER_SEP);
};

export const decodeFilters = (raw: string): D1Filter[] => {
  if (raw === "") {
    return [];
  }
  const filters: D1Filter[] = [];
  for (const part of raw.split(FILTER_SEP)) {
    const [column = "", op = "", ...rest] = part.split(FIELD_SEP);
    if (column === "" || !Object.hasOwn(FILTER_OP_LABELS, op)) {
      continue;
    }
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(column);
      value = decodeURIComponent(rest.join(FIELD_SEP));
    } catch {
      continue;
    }
    // SAFETY: the `Object.hasOwn` guard above proves `op` is a key of
    // FILTER_OP_LABELS, whose keys are exactly D1FilterOp.
    const kind = op as D1FilterOp;
    filters.push({ column: name, op: kind, value });
    if (filters.length >= MAX_FILTERS) {
      break;
    }
  }
  return filters;
};

export const encodeSort = (sort: D1RowsQuery["sort"]): string => {
  if (sort === null) {
    return "";
  }
  return `${sort.column}:${sort.desc ? "desc" : "asc"}`;
};

/** The last `:` splits the direction, so a column name may contain one. */
export const decodeSort = (raw: string): D1RowsQuery["sort"] => {
  const sep = raw.lastIndexOf(":");
  if (sep <= 0) {
    return null;
  }
  const dir = raw.slice(sep + 1);
  if (dir !== "asc" && dir !== "desc") {
    return null;
  }
  return { column: raw.slice(0, sep), desc: dir === "desc" };
};

export const toPageIndex = (raw: string): number =>
  Math.max(Math.trunc(Number(raw)) || 0, 0);

export const toPageSize = (raw: string): number => {
  const n = Math.trunc(Number(raw));
  // SAFETY: widening the readonly tuple to a number[] for `includes` is a
  // read-only view — no elements change type.
  const sizes = PAGE_SIZES as readonly number[];
  return sizes.includes(n) ? n : DEFAULT_PAGE_SIZE;
};

export const toView = (raw: string): D1View =>
  raw === "definition" ? "definition" : "data";

/** Drop filters/sort that no longer name a real, non-redacted column (a
 * stale URL or a table switch must not 400 the query). */
export const validSort = (
  sort: D1RowsQuery["sort"],
  schema?: D1TableSchema
): D1RowsQuery["sort"] => {
  if (sort === null || schema === undefined) {
    return null;
  }
  const column = schema.columns.find((c) => c.name === sort.column);
  if (column === undefined || schema.redacted.includes(sort.column)) {
    return null;
  }
  return sort;
};

export const validFilters = (
  filters: D1Filter[],
  schema?: D1TableSchema
): D1Filter[] => {
  if (schema === undefined) {
    return [];
  }
  return filters.filter(
    (filter) =>
      schema.columns.some((c) => c.name === filter.column) &&
      !schema.redacted.includes(filter.column)
  );
};

/** How many rows a page covers: at least 1 so "Page 1 of 1" always reads. */
export const pageCount = (total: number, pageSize: number): number =>
  Math.max(Math.ceil(total / pageSize), 1);
