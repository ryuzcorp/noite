//! One D1 grid cell: NULL badge, empty-string marker, redacted styling,
//! relative-time title for timestamps, monospace for ids/numbers, truncation
//! and a hover copy button. Read-only — the row editor owns editing.

import { formatAgo, formatDateTime } from "../../dates";
import type { D1Cell } from "../../runner";
import { CopyButton } from "../../ui/copy-button";
import { parseTimestamp } from "../d1-values";

const NUMERIC_TYPE_RE = /int|numeric|decimal|double|float|real/iu;
const NUMERIC_VALUE_RE = /^-?\d+(?:\.\d+)?$/u;

/** Monospace for id-shaped columns and numeric values. */
export const isMonoCell = (
  columnName: string,
  columnType: string,
  value: string
): boolean =>
  NUMERIC_TYPE_RE.test(columnType) ||
  /(?:^|_)id$/iu.test(columnName) ||
  NUMERIC_VALUE_RE.test(value);

export const CellValue = ({
  cell,
  columnName,
  columnType,
  redacted,
  timestamp,
}: {
  cell: D1Cell;
  columnName: string;
  columnType: string;
  /** A masked column (the value is the server's mask, never the secret). */
  redacted: boolean;
  /** Show a viewer-local hint in the title (column looks like a timestamp). */
  timestamp: boolean;
}) => {
  if (redacted) {
    return <span class="italic opacity-60">{cell ?? "•••• redacted"}</span>;
  }
  if (cell === null) {
    return (
      <span class="badge badge-ghost badge-sm font-normal opacity-60">
        NULL
      </span>
    );
  }
  if (cell === "") {
    return (
      <span class="text-xs italic opacity-40" title="empty string">
        {`""`}
      </span>
    );
  }
  const date = timestamp ? parseTimestamp(cell) : null;
  const title =
    date === null ? cell : `${formatDateTime(date)} · ${formatAgo(date)}`;
  const mono = isMonoCell(columnName, columnType, cell);
  return (
    <span class="group/cell flex min-w-0 items-center gap-1">
      <span
        class={`block max-w-[20rem] truncate ${mono ? "font-mono text-xs" : ""}`}
        title={title}
      >
        {cell}
      </span>
      <CopyButton
        class="btn btn-square btn-ghost btn-sm pointer-events-none h-6 min-h-0 w-6 shrink-0 opacity-0 group-hover/cell:pointer-events-auto group-hover/cell:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
        iconClass="h-3.5 w-3.5"
        iconOnly
        label={`Copy ${columnName}`}
        value={cell}
      />
    </span>
  );
};
