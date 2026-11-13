//! Usage charts: request / error / latency / memory / CPU bars over a chosen
//! window (24h / 7d / 1m), from the runner's hourly counters.
import { Link } from "@ilha/void";

import { api } from "../api";
import { formatDateTime, formatHour } from "../dates";
import {
  decodeMetrics,
  feedKeys,
  feedLoaded,
  feedProblem,
  feedRetrying,
  feedValue,
  liveFeed,
  metricsUrl,
} from "../feeds";
import type { MetricsFrame } from "../feeds";
import type { RunnerMetric } from "../runner";
import { Info } from "../ui/icons";

/** Windows the range picker offers, matching the control route's
 * METRICS_WINDOWS_HOURS (one window for every series). */
export const METRICS_RANGES = [
  { hours: 24, label: "last 24h", short: "24h" },
  { hours: 168, label: "last 7d", short: "7d" },
  { hours: 720, label: "last 30d", short: "1m" },
] as const;

export const DEFAULT_METRICS_HOURS = 24;

/** `?r=` → an offered window in hours; anything else is the default. */
export const toMetricsHours = (raw: string): number => {
  const asked = Number(raw);

  return (
    METRICS_RANGES.find((range) => range.hours === asked)?.hours ??
    DEFAULT_METRICS_HOURS
  );
};

const windowLabel = (hours: number): string =>
  METRICS_RANGES.find((range) => range.hours === hours)?.label ?? "last 24h";

// UTC hour-bucket keys (`2026-09-21T16`) matching the runner's UTC stamps,
// oldest first. Display only — labels go through bucketLabel (viewer-local,
// no TZ).
const hourKeys = (hours: number) =>
  Array.from({ length: hours }, (_, i) =>
    new Date(Date.now() - (hours - 1 - i) * 3_600_000)
      .toISOString()
      .slice(0, 13)
  );

/** Label for one bucket: the hour alone within a day, date + hour beyond. */
const bucketLabel = (key: string, hours: number): string =>
  hours <= 24 ? formatHour(key) : formatDateTime(`${key}:00:00Z`);

// First/last bucket labels for the axis. hourKeys always yields `hours`
// entries, so the fallbacks never render in practice.
const hourEnds = (keys: string[], hours: number): [string, string] => [
  bucketLabel(keys[0] ?? "", hours),
  bucketLabel(keys.at(-1) ?? "", hours),
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** How two values of the same series in one bucket combine. Requests, errors
 * and CPU add up; the percentiles and the memory peak are the bucket's own
 * value, so a second row (never produced today) must not be summed. */
const COMBINE: Record<"peak" | "sum", (a: number, b: number) => number> = {
  peak: Math.max,
  sum: (a, b) => a + b,
};

/** Mean over the buckets that carry traffic (percentiles and memory are
 * meaningless for an idle hour). */
const busyMean = (values: number[], counts: number[]): number => {
  const busy = values.filter((_, i) => (counts[i] ?? 0) > 0);

  return busy.length > 0 ? sum(busy) / busy.length : 0;
};

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  if (bytes >= 1024 ** 2) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} B`;
};

const BarChart = ({
  hours,
  keys,
  max,
  values,
}: {
  hours: number;
  keys: string[];
  max: number;
  values: number[];
}) => {
  const width = values.length * 10;

  return (
    <svg
      viewBox={`0 0 ${width} 64`}
      width="100%"
      height="100%"
      {...{ preserveAspectRatio: "none" }}
      role="img"
    >
      <line
        x1="0"
        y1="63.5"
        x2={width}
        y2="63.5"
        stroke="currentColor"
        stroke-width="1"
        opacity="0.25"
        {...{ "vector-effect": "non-scaling-stroke" }}
      />
      {values.map((v, i) => {
        const height = Math.max(1.5, (v / max) * 62).toFixed(1);
        const y = (64 - Number(height)).toFixed(1);
        const shown = Number.isInteger(v) ? `${v}` : v.toFixed(1);

        return (
          <>
            <rect
              x={i * 10 + 1}
              y={y}
              width="8"
              height={height}
              {...{ rx: "1.5" }}
              fill="currentColor"
            />
            <rect x={i * 10} y="0" width="10" height="64" fill="transparent">
              <title>
                {bucketLabel(keys[i] ?? "", hours)} · {shown}
              </title>
            </rect>
          </>
        );
      })}
    </svg>
  );
};

const BarRow = ({
  hours,
  keys,
  label,
  max,
  values,
}: {
  hours: number;
  keys: string[];
  /** Header row (label + total); omitted where the card already has a title. */
  label?: string;
  max: number;
  values: number[];
}) => (
  <div class="flex flex-col gap-1">
    {label ? (
      <div class="flex items-center justify-between text-xs opacity-80">
        <span>{label}</span>
        <span class="font-medium">{sum(values)}</span>
      </div>
    ) : null}
    <div class="text-primary/70 block h-16 w-full">
      <BarChart hours={hours} keys={keys} values={values} max={max} />
    </div>
    <div class="flex justify-between text-[10px] opacity-60">
      <span>{hourEnds(keys, hours)[0]}</span>
      <span>{hourEnds(keys, hours)[1]}</span>
    </div>
  </div>
);

const StatTiles = ({
  cpus,
  errs,
  hours,
  memAvgs,
  memPeaks,
  p50s,
  p95s,
  reqs,
}: {
  cpus: number[];
  errs: number[];
  hours: number;
  memAvgs: number[];
  memPeaks: number[];
  p50s: number[];
  p95s: number[];
  reqs: number[];
}) => {
  const period = windowLabel(hours);
  const totalReq = sum(reqs);
  const totalErr = sum(errs);
  const totalCpu = sum(cpus);

  const errRate =
    totalReq > 0 ? `${((100 * totalErr) / totalReq).toFixed(1)}%` : "—";

  const cpu =
    totalCpu >= 1000 ? `${(totalCpu / 1000).toFixed(1)} s` : `${totalCpu} ms`;

  const p50 = busyMean(p50s, reqs);
  const p95 = busyMean(p95s, reqs);
  const peak = Math.max(0, ...memPeaks);

  const tiles: [string, string, string][] = [
    ["Requests", totalReq.toLocaleString(), period],
    ["Error rate", errRate, `${totalErr.toLocaleString()} errors`],
    ["p50 latency", p50 > 0 ? `${Math.round(p50)} ms` : "—", "typical hour"],
    ["p95 latency", p95 > 0 ? `${Math.round(p95)} ms` : "—", "tail, per hour"],
    [
      "Memory peak",
      peak > 0 ? formatBytes(peak) : "—",
      peak > 0
        ? `${formatBytes(busyMean(memAvgs, reqs))} per hour`
        : "no cgroup reading",
    ],
    ["CPU time", cpu, period],
  ];

  return (
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-3">
      {tiles.map(([label, value, sub]) => (
        <section
          key={label}
          class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md"
        >
          <div class="card-body gap-1 p-4">
            <p class="m-0 text-xs opacity-70">{label}</p>
            <p class="m-0 text-2xl font-semibold">{value}</p>
            <p class="m-0 text-xs opacity-60">{sub}</p>
          </div>
        </section>
      ))}
    </div>
  );
};

const MetricsDetailCards = ({
  cpus,
  errs,
  hours,
  memAvgs,
  memPeaks,
  p50s,
  p95s,
  reqs,
}: {
  cpus: number[];
  errs: number[];
  hours: number;
  memAvgs: number[];
  memPeaks: number[];
  p50s: number[];
  p95s: number[];
  reqs: number[];
}) => {
  const keys = hourKeys(hours);

  const charts: [string, number[]][] = [
    ["Requests", reqs],
    ["Errors", errs],
    ["p50 latency (ms)", p50s],
    ["p95 latency (ms)", p95s],
    ["Memory peak (bytes)", memPeaks],
    ["CPU (ms)", cpus],
  ];

  return (
    <>
      <StatTiles
        cpus={cpus}
        errs={errs}
        hours={hours}
        memAvgs={memAvgs}
        memPeaks={memPeaks}
        p50s={p50s}
        p95s={p95s}
        reqs={reqs}
      />
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        {charts.map(([title, values]) => (
          <section
            key={title}
            class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md"
          >
            <div class="card-body gap-4">
              <h3 class="m-0 text-lg font-semibold">{title}</h3>
              <BarRow
                hours={hours}
                keys={keys}
                max={Math.max(1, ...values)}
                values={values}
              />
            </div>
          </section>
        ))}
      </div>
    </>
  );
};

const MetricsDetailView = ({
  cpus,
  errs,
  hasRows,
  hours,
  loadError,
  loaded,
  memAvgs,
  memPeaks,
  p50s,
  p95s,
  reqs,
}: {
  cpus: number[];
  errs: number[];
  hasRows: boolean;
  hours: number;
  loadError: string;
  loaded: boolean;
  memAvgs: number[];
  memPeaks: number[];
  p50s: number[];
  p95s: number[];
  reqs: number[];
}) => (
  <>
    {loadError ? <p class="text-error m-0 text-sm">{loadError}</p> : null}
    {!loaded && !hasRows && !loadError ? (
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <div
            role="status"
            aria-label="Loading metrics"
            class="flex flex-col gap-2"
          >
            <div class="skeleton h-4 w-64" />
            <div class="skeleton h-16 w-full" />
          </div>
        </div>
      </div>
    ) : null}
    {loaded && !hasRows && !loadError ? (
      <p class="m-0 text-sm opacity-70">
        No traffic recorded yet — hit the app URL to see requests and CPU.
      </p>
    ) : null}
    {loaded && hasRows && !loadError ? (
      <MetricsDetailCards
        cpus={cpus}
        errs={errs}
        hours={hours}
        memAvgs={memAvgs}
        memPeaks={memPeaks}
        p50s={p50s}
        p95s={p95s}
        reqs={reqs}
      />
    ) : null}
  </>
);

/** Per-bucket series over `keys` (oldest first): one pass over the rows, not
 * one filter per bucket — a 1-month window has 720 buckets. */
const byBucket = (
  rows: MetricsFrame["metrics"],
  keys: string[],
  pick: (row: RunnerMetric) => number,
  combine: (a: number, b: number) => number
): number[] => {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const key = row.bucketTs.slice(0, 13);
    const seen = totals.get(key);

    totals.set(key, seen === undefined ? pick(row) : combine(seen, pick(row)));
  }

  return keys.map((key) => totals.get(key) ?? 0);
};

/** Segmented control for the metrics window. Rendered by the page that owns
 * the `?r=` param, next to a `MetricsCard` it remounts per window (the live
 * feed's URL is fixed for the life of a component). */
export const MetricsRangePicker = ({
  hours,
  onPick,
}: {
  hours: number;
  onPick: (hours: number) => void;
}) => (
  <div class="join" role="group" aria-label="Metrics window">
    {METRICS_RANGES.map((range) => (
      <button
        key={range.hours}
        type="button"
        class={`btn btn-sm join-item ${hours === range.hours ? "btn-neutral" : "btn-ghost"}`}
        aria-pressed={hours === range.hours ? "true" : "false"}
        onclick={() => {
          onPick(range.hours);
        }}
      >
        {range.short}
      </button>
    ))}
  </div>
);

export const MetricsCard = ({
  appId,
  detail = false,
  environmentId = "",
  hours = DEFAULT_METRICS_HOURS,
  viewAllHref,
}: {
  appId: string;
  detail?: boolean;
  /** One preview environment (absent/"" is production). The feed key and
   * URL carry it, so each environment keeps its own snapshot and stream. */
  environmentId?: string;
  hours?: number;
  viewAllHref?: string;
}) => {
  // Usage reads the initial snapshot (or the last snapshot, or a skeleton
  // when cold) until the stream's first frame, then the stream pushes a
  // frame only when the request total moves.
  const feed = liveFeed(
    feedKeys.metrics(appId, hours, environmentId),
    metricsUrl(appId, hours, environmentId),
    decodeMetrics,
    {
      initial: async () => {
        const frame = await api<string | null>("/api/metrics/metricsFrame", {
          appId,
          environmentId,
          hours,
        });

        if (frame === null) {
          throw new Error("metrics frame unavailable");
        }

        return decodeMetrics(frame);
      },
    }
  );

  // Read the frame (or its stored snapshot) directly: no copy into atoms,
  // so a revisit paints the last numbers in the very first render.
  const frame: MetricsFrame["metrics"] = feedValue(feed.state())?.metrics ?? [];

  const loaded = (): boolean => feedLoaded(feed.state());

  const loadError = (): string =>
    feedRetrying(feed.state())
      ? "Usage stream disconnected — retrying…"
      : (feedProblem(feed.state()) ?? "");

  const keys = hourKeys(hours);

  const reqs = byBucket(frame, keys, (r) => r.requests, COMBINE.sum);
  const errs = byBucket(frame, keys, (r) => r.errors, COMBINE.sum);
  const p50s = byBucket(frame, keys, (r) => r.p50Ms, COMBINE.peak);
  const p95s = byBucket(frame, keys, (r) => r.p95Ms, COMBINE.peak);
  const memPeaks = byBucket(frame, keys, (r) => r.memoryMaxBytes, COMBINE.peak);
  const memAvgs = byBucket(frame, keys, (r) => r.memoryAvgBytes, COMBINE.peak);
  const cpus = byBucket(frame, keys, (r) => r.cpuMs, COMBINE.sum);

  const totalReq = sum(reqs);
  const totalErr = sum(errs);
  const totalCpu = sum(cpus);
  const peakMem = Math.max(0, ...memPeaks);

  return (
    <>
      {detail ? (
        <MetricsDetailView
          cpus={cpus}
          errs={errs}
          hasRows={frame.length > 0}
          hours={hours}
          loadError={loadError()}
          loaded={loaded()}
          memAvgs={memAvgs}
          memPeaks={memPeaks}
          p50s={p50s}
          p95s={p95s}
          reqs={reqs}
        />
      ) : (
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <div class="flex items-center justify-between gap-2">
              <h3 class="m-0 flex items-center gap-2 text-lg font-semibold">
                Metrics · {windowLabel(hours)}
                <span
                  class="tooltip tooltip-bottom sm:tooltip-right inline-flex opacity-60"
                  data-tip={`What the edge logged · ${windowLabel(hours)}: served requests, 5xx errors, p50/p95 latency, peak and mean memory, and CPU per hour.`}
                >
                  <Info />
                </span>
              </h3>
              {viewAllHref && !detail ? (
                <Link href={viewAllHref} class="btn btn-sm">
                  View All
                </Link>
              ) : null}
            </div>
            {loadError() ? (
              <p class="text-error m-0 text-sm">{loadError()}</p>
            ) : null}
            {!loaded() && frame.length === 0 && !loadError() ? (
              <div
                role="status"
                aria-label="Loading usage"
                class="flex flex-col gap-2"
              >
                <div class="skeleton h-4 w-64" />
                <div class="skeleton h-16 w-full" />
              </div>
            ) : null}
            {loaded() && frame.length === 0 && !loadError() ? (
              <p class="m-0 text-sm opacity-70">
                No traffic recorded yet — hit the app URL to see requests and
                CPU.
              </p>
            ) : (
              <>
                <BarRow
                  hours={hours}
                  keys={keys}
                  label={`Requests per hour`}
                  values={reqs}
                  max={Math.max(1, ...reqs)}
                />
                <p class="m-0 text-sm opacity-80">
                  {totalReq} requests · {totalErr} errors · p95{" "}
                  {Math.round(busyMean(p95s, reqs))} ms · peak{" "}
                  {formatBytes(peakMem)} · {totalCpu.toLocaleString()} ms CPU
                </p>
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
};
