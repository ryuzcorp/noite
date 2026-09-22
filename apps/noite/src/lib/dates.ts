/** Viewer-local date labels with no timezone ever shown (no names, no
 * offsets, no `Z`). Backend stamps stay UTC ISO — conversion happens here,
 * at the display edge, so buckets and comparisons keep working on strings.
 * Invalid input renders as an em dash, matching existing empty states. */
const dateTime = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

const hourOnly = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

const toDate = (value: string | Date | null | undefined): Date | null => {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Full stamp: `Sep 21, 4:44 PM` in the viewer's locale and zone. */
export const formatDateTime = (
  value: string | Date | null | undefined
): string => {
  const date = toDate(value);
  return date === null ? "—" : dateTime.format(date);
};

/** UTC hour-bucket key (`2026-09-21T16`) as a local hour: `4 PM`. The bar
 * still covers that UTC hour — same instant, honest label. */
export const formatHour = (utcHourKey: string): string => {
  const date = toDate(`${utcHourKey}:00:00Z`);
  return date === null ? "—" : hourOnly.format(date);
};
