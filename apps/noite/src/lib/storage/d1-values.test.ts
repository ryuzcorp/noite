import { describe, expect, test } from "bun:test";

import type { D1Column } from "../runner";
import {
  cellFromDraft,
  draftDiffers,
  draftFromCell,
  formatJson,
  isBlobText,
  isBoolType,
  isJsonLooking,
  isTimestampColumn,
  jsonValid,
  keyFor,
  nowValue,
  parseTimestamp,
  prefersTextarea,
  timestampKind,
  writeValues,
  writtenColumns,
} from "./d1-values";

// The representation better-auth/paranorm writes today: ISO 8601 with
// milliseconds and a Z suffix.
const ISO = "2026-10-06T07:29:28.530Z";
// What SQLite's `CURRENT_TIMESTAMP` default writes into the same column.
const SQLITE_NOW = "2026-10-06 07:29:28";
// An epoch-millisecond int and a seconds int, as the runner stringifies them.
const EPOCH_MS = "1759735768530";
const EPOCH_S = "1759735768";

const col = (
  name: string,
  type = "TEXT",
  extra: Partial<D1Column> = {}
): D1Column => ({
  defaultValue: null,
  name,
  notNull: false,
  pk: 0,
  type,
  ...extra,
});

const COLUMNS: D1Column[] = [
  col("id", "varchar(255)", { notNull: true, pk: 1 }),
  col("name"),
  col("counter", "INTEGER"),
  col("note"),
  col("createdAt", "timestamp"),
];

const ROW = {
  counter: "7",
  createdAt: ISO,
  id: "u1",
  name: "Ada",
  note: "",
} satisfies Record<string, string | null>;

/** Seed drafts from a row, then apply the user's patch (text or NULL). */
const draftsFrom = (
  columns: D1Column[],
  row: Record<string, string | null>,
  patch: Record<string, string | null> = {}
) => {
  const drafts = Object.fromEntries(
    columns.map((c) => [c.name, draftFromCell(row[c.name] ?? null)])
  );
  for (const [name, value] of Object.entries(patch)) {
    drafts[name] = { isNull: value === null, text: value ?? "", touched: true };
  }
  return drafts;
};

/** The editor's UPDATE path: seed the row, apply the patch, diff. */
const updateValues = (
  patch: Record<string, string | null>,
  locked: string[] = []
) =>
  writeValues({
    columns: COLUMNS,
    drafts: draftsFrom(COLUMNS, ROW, patch),
    isEdit: true,
    locked,
    original: ROW,
  });

/** The editor's INSERT path: every field starts untouched. */
const insertValues = (
  patch: Record<string, string | null>,
  locked: string[] = []
) =>
  writeValues({
    columns: COLUMNS,
    drafts: draftsFrom(COLUMNS, {}, patch),
    isEdit: false,
    locked,
    original: {},
  });

describe("drafts", () => {
  test("NULL and empty string seed distinguishable drafts", () => {
    expect(draftFromCell(null)).toEqual({
      isNull: true,
      text: "",
      touched: false,
    });
    expect(draftFromCell("")).toEqual({
      isNull: false,
      text: "",
      touched: false,
    });
    expect(draftFromCell(EPOCH_MS)).toEqual({
      isNull: false,
      text: EPOCH_MS,
      touched: false,
    });
  });

  test("a draft writes back NULL or the exact text", () => {
    expect(
      cellFromDraft({ isNull: true, text: "ignored", touched: true })
    ).toBeNull();
    expect(cellFromDraft({ isNull: false, text: "", touched: true })).toBe("");
    expect(cellFromDraft({ isNull: false, text: ISO, touched: false })).toBe(
      ISO
    );
  });

  test("NULL and empty string differ from each other", () => {
    const empty = { isNull: false, text: "", touched: false };
    const nullish = { isNull: true, text: "", touched: false };
    expect(draftDiffers(empty, null)).toBe(true);
    expect(draftDiffers(nullish, "")).toBe(true);
    expect(draftDiffers(nullish, null)).toBe(false);
    expect(draftDiffers(empty, "")).toBe(false);
    expect(
      draftDiffers({ isNull: false, text: "x", touched: false }, "x")
    ).toBe(false);
  });
});

describe("writeValues (update)", () => {
  test("carries only the changed column", () => {
    expect(updateValues({ name: "Ada Lovelace" })).toEqual({
      name: "Ada Lovelace",
    });
  });

  test("an untouched timestamp is never rewritten or nulled", () => {
    const values = updateValues({ counter: "8" });
    expect(Object.keys(values)).toEqual(["counter"]);
    expect(values.createdAt).toBeUndefined();
  });

  test('setting a value to NULL sends null, blanking it sends ""', () => {
    expect(updateValues({ createdAt: null })).toEqual({ createdAt: null });
    expect(updateValues({ name: "" })).toEqual({ name: "" });
  });

  test("the primary key and locked columns never travel", () => {
    expect(updateValues({ id: "other", note: "hi" }, ["note"])).toEqual({});
  });

  test("an empty update has no columns to send", () => {
    expect(updateValues({})).toEqual({});
    expect(
      writtenColumns({
        columns: COLUMNS,
        drafts: draftsFrom(COLUMNS, ROW, {}),
        isEdit: true,
        locked: [],
        original: ROW,
      })
    ).toEqual([]);
  });
});

describe("writeValues (insert)", () => {
  test("omits untouched fields so their DDL defaults apply", () => {
    expect(insertValues({ name: "Ada" })).toEqual({ name: "Ada" });
  });

  test("a touched-but-empty field is an empty string, NULL is null", () => {
    expect(insertValues({ counter: null, note: "" })).toEqual({
      counter: null,
      note: "",
    });
  });

  test("an untouched primary key is omitted so the backend can fill it", () => {
    const values = insertValues({ name: "Ada" });
    expect(values.id).toBeUndefined();
    expect(
      writtenColumns({
        columns: COLUMNS,
        drafts: draftsFrom(COLUMNS, {}, { name: "Ada" }),
        isEdit: false,
        locked: [],
        original: {},
      })
    ).toEqual(["name"]);
  });

  test("locked fields never travel", () => {
    expect(insertValues({ name: "Ada", note: "x" }, ["note"])).toEqual({
      name: "Ada",
    });
  });
});

describe("keyFor", () => {
  test("uses the primary key columns when present", () => {
    expect(keyFor(COLUMNS, ROW)).toEqual({ id: "u1" });
  });

  test("falls back to every column without a pk, NULL-aware", () => {
    const columns = [col("a"), col("b")];
    expect(keyFor(columns, { a: "1", b: null })).toEqual({ a: "1", b: null });
  });
});

describe("timestampKind", () => {
  test("recognizes each stored shape", () => {
    expect(timestampKind(ISO)).toBe("iso");
    expect(timestampKind("2026-10-06T07:29:28Z")).toBe("iso");
    expect(timestampKind(SQLITE_NOW)).toBe("datetime");
    expect(timestampKind(EPOCH_MS)).toBe("epoch_ms");
    expect(timestampKind(EPOCH_S)).toBe("epoch_s");
  });

  test("rejects non-timestamps and out-of-range epochs", () => {
    expect(timestampKind(null)).toBeNull();
    expect(timestampKind("")).toBeNull();
    expect(timestampKind("hello")).toBeNull();
    expect(timestampKind("1759735768.5")).toBeNull();
    // A 13-digit id outside 2000..2100 is not a millisecond stamp.
    expect(timestampKind("9999999999999")).toBeNull();
  });

  test("Now writes in the field's existing shape", () => {
    expect(nowValue("iso")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    );
    expect(nowValue("datetime")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u
    );
    expect(nowValue("epoch_ms")).toMatch(/^\d{13}$/u);
    expect(nowValue("epoch_s")).toMatch(/^\d{10}$/u);
    // Default (unknown shape) is ISO with milliseconds and Z.
    expect(nowValue(null)).toMatch(/Z$/u);
  });

  test("parseTimestamp decodes each shape to the same instant", () => {
    const expected = Date.parse(ISO);
    expect(parseTimestamp(ISO)?.getTime()).toBe(expected);
    expect(parseTimestamp(SQLITE_NOW)?.getTime()).toBe(
      Date.parse(`${SQLITE_NOW.replace(" ", "T")}Z`)
    );
    expect(parseTimestamp(EPOCH_MS)?.getTime()).toBe(1_759_735_768_530);
    expect(parseTimestamp(EPOCH_S)?.getTime()).toBe(1_759_735_768_000);
    expect(parseTimestamp("nope")).toBeNull();
  });
});

describe("isTimestampColumn", () => {
  test("matches camelCase and snake_case names and date types", () => {
    expect(isTimestampColumn("createdAt", "")).toBe(true);
    expect(isTimestampColumn("updated_at", "")).toBe(true);
    expect(isTimestampColumn("expires", "")).toBe(true);
    expect(isTimestampColumn("timestamp", "")).toBe(true);
    expect(isTimestampColumn("when", "DATETIME")).toBe(true);
    expect(isTimestampColumn("timeout", "")).toBe(false);
    expect(isTimestampColumn("format", "")).toBe(false);
    expect(isTimestampColumn("name", "TEXT")).toBe(false);
  });
});

describe("JSON helpers", () => {
  test("detects object/array text only", () => {
    expect(isJsonLooking('{"a":1}')).toBe(true);
    expect(isJsonLooking("  [1,2]")).toBe(true);
    expect(isJsonLooking("1")).toBe(false);
    expect(isJsonLooking("hello")).toBe(false);
  });

  test("validity and formatting", () => {
    expect(jsonValid('{"a":1}')).toBe(true);
    expect(jsonValid("{oops}")).toBe(false);
    expect(jsonValid("plain")).toBeNull();
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatJson("{oops}")).toBeNull();
    expect(formatJson("plain")).toBeNull();
  });
});

describe("column shapes", () => {
  test("BOOL types, blobs and textarea preference", () => {
    expect(isBoolType("BOOL")).toBe(true);
    expect(isBoolType(" boolean ")).toBe(true);
    expect(isBoolType("INTEGER")).toBe(false);
    expect(isBlobText("x'deadBEEF'")).toBe(true);
    expect(isBlobText("x'not-hex!'")).toBe(false);
    expect(prefersTextarea("short")).toBe(false);
    expect(prefersTextarea("x".repeat(81))).toBe(true);
    expect(prefersTextarea("a\nb")).toBe(true);
    expect(prefersTextarea("[1,2]")).toBe(true);
  });
});
