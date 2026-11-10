//! The D1 editor's URL query as one value with one transition function.
//!
//! The URL is this machine's public surface (deep links, back/forward), so
//! the invariants that used to live in the setters — "any of filters, sort,
//! search or page size resets the page to 0", "switching table clears
//! everything", "an FK jump forces the data view" — are enforced here, once.
//! `setView` deliberately keeps the page: switching between Data and
//! Definition is not a query change.
//!
//! ```text
//! Query ──filter/sort/search/size──▶ Query{…, page: 0}
//! Query ──page────────────────────▶ Query{…, page}
//! Query ──view────────────────────▶ Query{…, view}        (page kept)
//! Query ──table───────────────────▶ fresh(table)          (filters/sort/search/page cleared)
//! Query ──fkJump──────────────────▶ Query{table, one eq filter, data view, page 0, no sort/search}
//! ```

import type { D1Cell, D1Filter, D1RowsQuery } from "../../runner";
import type { D1View } from "./state";

/** Everything the D1 editor reads from (and writes to) the URL. */
export interface EditorQuery {
  readonly filters: readonly D1Filter[];
  readonly page: number;
  readonly pageSize: number;
  readonly search: string;
  readonly sort: D1RowsQuery["sort"];
  readonly view: D1View;
}

/** What moves an {@link EditorQuery}. */
export type EditorQueryEvent =
  | { readonly filters: readonly D1Filter[]; readonly kind: "filters" }
  | { readonly kind: "sort"; readonly sort: D1RowsQuery["sort"] }
  | { readonly kind: "search"; readonly search: string }
  | { readonly kind: "size"; readonly size: number }
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "view"; readonly view: D1View }
  | { readonly kind: "table" }
  | {
      readonly column: string;
      readonly kind: "fkJump";
      readonly table: string;
      readonly value: D1Cell;
    };

/** The one transition function for the D1 URL query. */
export const nextEditorQuery = (
  query: EditorQuery,
  event: EditorQueryEvent
): EditorQuery => {
  switch (event.kind) {
    case "filters": {
      return { ...query, filters: event.filters, page: 0 };
    }

    case "sort": {
      return { ...query, page: 0, sort: event.sort };
    }

    case "search": {
      return { ...query, page: 0, search: event.search };
    }

    case "size": {
      return { ...query, page: 0, pageSize: event.size };
    }

    case "page": {
      return {
        ...query,
        page: Number.isFinite(event.page) ? Math.max(0, event.page) : 0,
      };
    }

    case "view": {
      return { ...query, view: event.view };
    }

    case "table": {
      return {
        filters: [],
        page: 0,
        pageSize: query.pageSize,
        search: "",
        sort: null,
        view: query.view,
      };
    }

    case "fkJump": {
      return {
        filters:
          event.value === null
            ? []
            : [{ column: event.column, op: "eq", value: event.value }],
        page: 0,
        pageSize: query.pageSize,
        search: "",
        sort: null,
        view: "data",
      };
    }

    default: {
      return query;
    }
  }
};
