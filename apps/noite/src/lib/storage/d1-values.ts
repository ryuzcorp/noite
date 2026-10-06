//! Row/column value rules for the D1 table editor, kept in a plain module
//! (no JSX, no ilha) so the rules are unit-tested against the wire contract.
//!
//! A cell is either SQL NULL (`null`) or its exact stored text — the editor
//! never re-renders a value into another representation. It edits raw text
//! and sends only the columns the user touched: an untouched UPDATE field
//! round-trips byte for byte, and an untouched INSERT field is omitted so its
//! DDL default applies.

import type { D1Cell, D1Column, D1Key } from "../runner";

/** One editable field's draft: raw text plus an explicit SQL NULL flag.
 * `touched` records whether the user changed anything — INSERT needs it,
 * because an untouched field must be omitted rather than sent as "". */
export interface FieldDraft {
  isNull: boolean;
  text: string;
  touched: boolean;
}

/** Drafts keyed by column name. */
export type FieldDrafts = Record<string, FieldDraft>;

/** Seed a field from one cell. NULL becomes an empty, NULL-flagged draft;
 * a string (including "") becomes an untouched text draft. */
export const draftFromCell = (cell: D1Cell): FieldDraft => ({
  isNull: cell === null,
  text: cell ?? "",
  touched: false,
});

/** The value a draft writes: SQL NULL, or the text exactly as typed. */
export const cellFromDraft = (draft: FieldDraft): D1Cell =>
  draft.isNull ? null : draft.text;

/** Whether a draft differs from the cell it was seeded from. `null` and `""`
 * are different values and must be distinguishable here (the old editor's
 * "empty means NULL" rule is exactly what this replaces). */
export const draftDiffers = (draft: FieldDraft, original: D1Cell): boolean =>
  draft.isNull !== (original === null) || draft.text !== (original ?? "");

/** Row identity per the contract: the PK columns' current values, or every
 * column's value when the table has no PK. NULL-aware. */
export const keyFor = (
  columns: readonly D1Column[],
  row: Record<string, D1Cell>
): D1Key => {
  const primary = columns.filter((column) => column.pk > 0);
  const names =
    primary.length > 0
      ? primary.map((c) => c.name)
      : columns.map((c) => c.name);
  const key: D1Key = {};
  for (const name of names) {
    const value = row[name];
    key[name] = value === undefined ? null : value;
  }
  return key;
};

/** Columns a write must not touch: policy-locked, redacted, binary, or (on
 * UPDATE) the primary key — the key identifies the row. */
export interface WriteScope {
  columns: readonly D1Column[];
  drafts: FieldDrafts;
  /** UPDATE: send only columns that differ from `original`. */
  isEdit: boolean;
  /** Columns the editor must never write back. */
  locked: readonly string[];
  /** The row the editor opened on ({} for INSERT). */
  original: Record<string, D1Cell>;
}

/** The column names a save would carry (the footer's "N changes"). */
export const writtenColumns = (scope: WriteScope): string[] => {
  const skip = new Set(scope.locked);
  const names: string[] = [];
  for (const column of scope.columns) {
    if (skip.has(column.name) || (scope.isEdit && column.pk > 0)) {
      continue;
    }
    const original = scope.original[column.name] ?? null;
    const draft = scope.drafts[column.name] ?? draftFromCell(original);
    if (scope.isEdit) {
      if (draftDiffers(draft, original)) {
        names.push(column.name);
      }
    } else if (draft.touched) {
      names.push(column.name);
    }
  }
  return names;
};

/** The update/insert `values` payload for the current drafts. */
export const writeValues = (scope: WriteScope) => {
  const values: Record<string, D1Cell> = {};
  for (const name of writtenColumns(scope)) {
    const original = scope.original[name] ?? null;
    const draft = scope.drafts[name] ?? draftFromCell(original);
    values[name] = cellFromDraft(draft);
  }
  return values;
};

// --- timestamps -----------------------------------------------------------
// `Now` must write in the same shape the field already holds: rewriting a
// column's format would change a value the user never meant to change.

export type TimestampKind = "datetime" | "epoch_ms" | "epoch_s" | "iso";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/u;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;
const EPOCH_MS_RE = /^\d{13}$/u;
const EPOCH_S_RE = /^\d{10}$/u;
// Plausible-epoch guard: a 13-digit number outside 2000..2100 is an id, not
// a millisecond stamp, and must not render (or be rewritten) as a timestamp.
const EPOCH_MIN_MS = 946_684_800_000;
const EPOCH_MAX_MS = 4_102_444_800_000;

const epochMs = (value: string): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < EPOCH_MIN_MS || n > EPOCH_MAX_MS) {
    return null;
  }
  return n;
};

/** The stored shape of a timestamp-looking value, else null. */
export const timestampKind = (value: D1Cell): TimestampKind | null => {
  if (value === null || value === "") {
    return null;
  }
  if (ISO_RE.test(value)) {
    return Number.isNaN(Date.parse(value)) ? null : "iso";
  }
  if (DATETIME_RE.test(value)) {
    const normalized = value.replace(" ", "T");
    return Number.isNaN(Date.parse(`${normalized}Z`)) ? null : "datetime";
  }
  if (EPOCH_MS_RE.test(value)) {
    return epochMs(value) === null ? null : "epoch_ms";
  }
  if (EPOCH_S_RE.test(value)) {
    return epochMs(`${value}000`) === null ? null : "epoch_s";
  }
  return null;
};

/** Parse a timestamp-kind cell into a Date, else null. */
export const parseTimestamp = (value: D1Cell): Date | null => {
  const kind = timestampKind(value);
  if (kind === null || value === null) {
    return null;
  }
  if (kind === "epoch_ms") {
    const n = epochMs(value);
    return n === null ? null : new Date(n);
  }
  if (kind === "epoch_s") {
    const seconds = Number(value) * 1000;
    return epochMs(String(seconds)) === null ? null : new Date(seconds);
  }
  if (kind === "datetime") {
    return new Date(`${value.replace(" ", "T")}Z`);
  }
  return new Date(value);
};

/** Now, in the shape `kind` names (UTC, matching SQLite's CURRENT_TIMESTAMP
 * conventions). Defaults to ISO 8601 with milliseconds and a `Z`. */
export const nowValue = (kind: TimestampKind | null): string => {
  const now = new Date();
  if (kind === "epoch_ms") {
    return String(now.getTime());
  }
  if (kind === "epoch_s") {
    return String(Math.floor(now.getTime() / 1000));
  }
  if (kind === "datetime") {
    return now.toISOString().slice(0, 19).replace("T", " ");
  }
  return now.toISOString();
};

// A column named like a timestamp (snake_case or camelCase) or declared as
// one. Only such columns get the Now helper.
const TIME_TOKENS = {
  at: true,
  date: true,
  datetime: true,
  expired: true,
  expires: true,
  finished: true,
  last: true,
  started: true,
  time: true,
  timestamp: true,
} satisfies Record<string, true>;
const CAMEL_RE = /(?<lower>[a-z0-9])(?<upper>[A-Z])/gu;

export const isTimestampColumn = (name: string, type: string): boolean => {
  const snake = name.replace(CAMEL_RE, "$<lower>_$<upper>").toLowerCase();
  for (const token of snake.split("_")) {
    if (Object.hasOwn(TIME_TOKENS, token)) {
      return true;
    }
  }
  return /date|time/iu.test(type);
};

// --- JSON ----------------------------------------------------------------

/** Whether a text looks like a JSON object/array (drives the textarea and
 * the Format helper). */
export const isJsonLooking = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
};

/** `true`/`false` for JSON-looking text, null when it does not look like
 * JSON at all (no hint to show). */
export const jsonValid = (value: string): boolean | null => {
  if (!isJsonLooking(value)) {
    return null;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

/** Pretty-print JSON-looking text, or null when it is not valid JSON. */
export const formatJson = (value: string): string | null => {
  if (!isJsonLooking(value)) {
    return null;
  }
  try {
    // SAFETY: JSON.parse accepts any JSON text; the editor only ever passes
    // user text and re-stringifies whatever parses.
    const parsed: unknown = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
};

// --- misc column shapes --------------------------------------------------

/** BOOL/BOOLEAN columns get a 0/1 toggle. */
export const isBoolType = (type: string): boolean => {
  const normalized = type.trim().toUpperCase();
  return normalized === "BOOL" || normalized === "BOOLEAN";
};

/** A blob ships as `x'…'` hex and is read-only in the editor. */
export const isBlobText = (value: string): boolean =>
  /^x'[0-9a-f]*'$/iu.test(value);

/** Long, multiline or JSON-looking text gets a textarea. */
export const prefersTextarea = (value: string): boolean =>
  value.length > 80 || value.includes("\n") || isJsonLooking(value);
