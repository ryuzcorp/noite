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

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** How long something took, coarsely: `42s`, `1m 42s`, `2h 5m`. Whole
 * seconds below an hour, whole minutes above it; `null` when either stamp is
 * missing or unparseable, so callers render nothing instead of `NaN`. */
export const formatDuration = (
  start: string | Date | null | undefined,
  end: string | Date | null | undefined
): string | null => {
  const from = toDate(start);
  const to = toDate(end);

  if (from === null || to === null) {
    return null;
  }

  const total = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
};

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
];

/** How long ago, coarsely: `5 minutes ago`, `yesterday`. */
export const formatAgo = (
  value: string | Date | null | undefined,
  now: number = Date.now()
): string => {
  const date = toDate(value);

  if (date === null) {
    return "—";
  }

  let amount = Math.round((date.getTime() - now) / 1000);

  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(amount) < size) {
      return relative.format(amount, unit);
    }

    amount = Math.round(amount / size);
  }

  return relative.format(amount, "year");
};
