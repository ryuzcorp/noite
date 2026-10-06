import { describe, expect, test } from "bun:test";

import type { D1TableSchema } from "../../runner";
import {
  decodeFilters,
  decodeSort,
  encodeFilters,
  encodeSort,
  MAX_FILTERS as maxFilters,
  pageCount,
  toPageIndex,
  toPageSize,
  toView,
  validFilters,
  validSort,
} from "./state";

describe("filters", () => {
  test("round-trips values containing the separators", () => {
    const filters = [
      { column: "name", op: "eq" as const, value: "a~b|c" },
      { column: "note", op: "like" as const, value: "%50%+" },
      { column: "deletedAt", op: "is_null" as const, value: "" },
    ];
    expect(decodeFilters(encodeFilters(filters))).toEqual(filters);
  });

  test("drops malformed entries instead of failing the query", () => {
    expect(decodeFilters("nope")).toEqual([]);
    expect(decodeFilters("a~bogus~1")).toEqual([]);
    expect(decodeFilters("~eq~1")).toEqual([]);
    expect(decodeFilters("a~eq~%E0%A4%A")).toEqual([]);
  });

  test("caps at the server's filter limit", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      column: `c${i}`,
      op: "eq" as const,
      value: String(i),
    }));
    expect(decodeFilters(encodeFilters(many))).toHaveLength(maxFilters);
  });
});

describe("sort", () => {
  test("round-trips a column that contains a colon", () => {
    const sort = { column: "a:b", desc: true };
    expect(decodeSort(encodeSort(sort))).toEqual(sort);
  });

  test("no sort is an empty string", () => {
    expect(encodeSort(null)).toBe("");
    expect(decodeSort("")).toBeNull();
    expect(decodeSort("name:sideways")).toBeNull();
    expect(decodeSort("nocolon")).toBeNull();
  });
});

describe("scalars", () => {
  test("page, size and view parse defensively", () => {
    expect(toPageIndex("-3")).toBe(0);
    expect(toPageIndex("x")).toBe(0);
    expect(toPageIndex("4")).toBe(4);
    expect(toPageSize("50")).toBe(50);
    expect(toPageSize("10")).toBe(25);
    expect(toPageSize("9000")).toBe(25);
    expect(toView("definition")).toBe("definition");
    expect(toView("bogus")).toBe("data");
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(51, 25)).toBe(3);
  });
});

const SCHEMA: D1TableSchema = {
  caps: { delete: true, insert: true, update: true },
  columns: [
    { defaultValue: null, name: "id", notNull: true, pk: 1, type: "TEXT" },
    { defaultValue: null, name: "token", notNull: true, pk: 0, type: "TEXT" },
    { defaultValue: null, name: "note", notNull: false, pk: 0, type: "TEXT" },
  ],
  foreignKeys: [],
  indexes: [],
  locked: {},
  redacted: ["token"],
  rowAction: null,
  sql: null,
  table: "session",
};

describe("validation against a schema", () => {
  test("a redacted or unknown sort column is dropped", () => {
    expect(validSort({ column: "token", desc: false }, SCHEMA)).toBeNull();
    expect(validSort({ column: "nope", desc: false }, SCHEMA)).toBeNull();
    expect(validSort({ column: "note", desc: true }, SCHEMA)).toEqual({
      column: "note",
      desc: true,
    });
    expect(validSort({ column: "note", desc: false })).toBeNull();
  });

  test("filters on redacted or unknown columns are dropped", () => {
    expect(
      validFilters(
        [
          { column: "token", op: "eq", value: "x" },
          { column: "nope", op: "eq", value: "x" },
          { column: "note", op: "eq", value: "x" },
        ],
        SCHEMA
      )
    ).toEqual([{ column: "note", op: "eq", value: "x" }]);
    expect(validFilters([{ column: "note", op: "eq", value: "x" }])).toEqual(
      []
    );
  });
});
