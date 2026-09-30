//! Usage charts: request/CPU bars over a chosen window (24h / 7d / 1m) + spans table.
import { atom } from "ilha";

import { formatDateTime, formatHour } from "../dates";
import { decodeMetrics, feedKeys, liveFeed, metricsUrl } from "../feeds";
import type { MetricsFrame } from "../feeds";
import { Info } from "../icons";
import type {
  RunnerDevice,
  RunnerMetric,
  RunnerPath,
  RunnerRef,
  RunnerSpan,
} from "../runner";

/** Windows the range picker offers, matching the control route's
 * METRICS_WINDOWS_HOURS (all series share one window). */
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

// Per-hour average from parallel totals/counts (zero where no traffic).
const perReqAvg = (totals: number[], counts: number[]) =>
  totals.map((t, i) => {
    const n = counts[i] ?? 0;
    return n > 0 ? t / n : 0;
  });

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
  lats,
  reqs,
}: {
  cpus: number[];
  errs: number[];
  hours: number;
  lats: number[];
  reqs: number[];
}) => {
  const period = windowLabel(hours);
  const totalReq = sum(reqs);
  const totalErr = sum(errs);
  const totalLat = sum(lats);
  const totalCpu = sum(cpus);
  const errRate =
    totalReq > 0 ? `${((100 * totalErr) / totalReq).toFixed(1)}%` : "—";
  const avgLat = totalReq > 0 ? `${Math.round(totalLat / totalReq)} ms` : "—";
  const cpu =
    totalCpu >= 1000 ? `${(totalCpu / 1000).toFixed(1)} s` : `${totalCpu} ms`;
  const tiles: [string, string, string][] = [
    ["Requests", totalReq.toLocaleString(), period],
    ["Error rate", errRate, `${totalErr.toLocaleString()} errors`],
    ["Avg latency", avgLat, "per request"],
    ["CPU time", cpu, period],
  ];
  return (
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
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

/** Per-browser OS mix for the Browsers table sub-lines: top 3 OSes by
 * share of that browser's own traffic (`macOS 60% · Windows 40%`). */
const browserOsSubs = (devices: RunnerDevice[]) => {
  const perBrowser: Record<string, Record<string, number>> = {};
  for (const d of devices) {
    const os = d.os === "" ? "Unknown" : d.os;
    let byOs = perBrowser[d.browser];
    if (!byOs) {
      byOs = {};
      perBrowser[d.browser] = byOs;
    }
    byOs[os] = (byOs[os] ?? 0) + d.requests;
  }
  const subs: Record<string, string> = {};
  for (const [browser, oses] of Object.entries(perBrowser)) {
    const total = sum(Object.values(oses));
    subs[browser] = Object.entries(oses)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(
        ([os, n]) => `${os} ${total > 0 ? ((100 * n) / total).toFixed(0) : 0}%`
      )
      .join(" · ");
  }
  return subs;
};

const BreakdownSection = ({
  empty,
  entries,
  head,
  subs,
  title,
}: {
  empty: string;
  entries: [string, number][];
  head: string;
  subs?: Record<string, string>;
  title: string;
}) => {
  const total = sum(entries.map(([, n]) => n));
  const grouped: Record<string, number> = {};
  for (const [label, n] of entries) {
    grouped[label] = (grouped[label] ?? 0) + n;
  }
  const ranked = Object.entries(grouped).toSorted((a, b) => b[1] - a[1]);
  // Analytics tables stay scannable: top 5 rows, overflow as a count.
  const shown = ranked.slice(0, 5);
  const extra = ranked.length - shown.length;
  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <h3 class="m-0 text-lg font-semibold">{title}</h3>
        <div class="flex flex-col gap-2">
          {ranked.length > 0 ? (
            <div class="overflow-x-auto">
              <table class="table-sm table">
                <thead>
                  <tr>
                    <th>{head}</th>
                    <th class="text-right">requests</th>
                    <th class="text-right">share</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(([label, n]) => (
                    <tr key={label}>
                      <td class="font-mono text-xs">
                        {label}
                        {subs?.[label] ? (
                          <div class="opacity-60">{subs[label]}</div>
                        ) : null}
                      </td>
                      <td class="text-right">{n.toLocaleString()}</td>
                      <td class="text-right">
                        {total > 0 ? `${((100 * n) / total).toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {extra > 0 ? (
                <p class="m-0 text-xs opacity-60">+{extra} more</p>
              ) : null}
            </div>
          ) : (
            <p class="m-0 text-sm opacity-70">{empty}</p>
          )}
        </div>
      </div>
    </section>
  );
};

const MetricsDetailCards = ({
  cpus,
  devices,
  errs,
  hours,
  lats,
  paths,
  refs,
  reqs,
  spans,
  spansError,
}: {
  cpus: number[];
  devices: RunnerDevice[];
  errs: number[];
  hours: number;
  lats: number[];
  paths: RunnerPath[];
  refs: RunnerRef[];
  reqs: number[];
  spans: RunnerSpan[];
  spansError: string;
}) => {
  const keys = hourKeys(hours);
  return (
    <>
      <StatTiles
        cpus={cpus}
        errs={errs}
        hours={hours}
        lats={lats}
        reqs={reqs}
      />
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <h3 class="m-0 text-lg font-semibold">Requests</h3>
            <BarRow
              hours={hours}
              keys={keys}
              values={reqs}
              max={Math.max(1, ...reqs)}
            />
          </div>
        </section>
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <h3 class="m-0 text-lg font-semibold">Errors</h3>
            <BarRow
              hours={hours}
              keys={keys}
              values={errs}
              max={Math.max(1, ...errs)}
            />
          </div>
        </section>
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <h3 class="m-0 text-lg font-semibold">Latency</h3>
            <BarRow
              hours={hours}
              keys={keys}
              values={perReqAvg(lats, reqs)}
              max={Math.max(1, ...perReqAvg(lats, reqs))}
            />
          </div>
        </section>
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <h3 class="m-0 text-lg font-semibold">CPU</h3>
            <BarRow
              hours={hours}
              keys={keys}
              values={cpus}
              max={Math.max(1, ...cpus)}
            />
          </div>
        </section>
      </div>
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <h3 class="m-0 text-lg font-semibold">Spans</h3>
          <div class="flex flex-col gap-2">
            {spansError ? (
              <p class="text-warning m-0 text-xs">
                Spans unavailable: {spansError}
              </p>
            ) : null}
            {spans.length > 0 ? (
              <div class="overflow-x-auto">
                <table class="table-sm table">
                  <thead>
                    <tr>
                      <th>Span</th>
                      <th class="text-right">n</th>
                      <th class="text-right">ms</th>
                      <th class="text-right">err</th>
                      <th class="text-right">err %</th>
                      <th class="text-right">queue ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spans
                      .toSorted((a, b) => b.ms - a.ms)
                      .map((s) => (
                        <tr key={s.name}>
                          <td class="font-mono text-xs">{s.name}</td>
                          <td class="text-right">{s.n.toLocaleString()}</td>
                          <td class="text-right">{s.ms.toLocaleString()}</td>
                          <td class="text-right">
                            {s.err > 0 ? (
                              <span class="text-error">{s.err}</span>
                            ) : (
                              "0"
                            )}
                          </td>
                          <td class="text-right">
                            {s.n > 0
                              ? `${((100 * s.err) / s.n).toFixed(1)}%`
                              : "—"}
                          </td>
                          <td class="text-right">
                            {s.qwaitMs.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {spans.length === 0 && !spansError ? (
              <p class="m-0 text-sm opacity-70">
                No spans in the {windowLabel(hours)} — spans come from the
                fleet's traces.
              </p>
            ) : null}
          </div>
        </div>
      </section>
      <h3 class="m-0 text-lg font-semibold">Analytics</h3>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <BreakdownSection
          empty="No browser data yet — visit the app URL, then reload."
          entries={devices.map((d): [string, number] => [
            d.browser,
            d.requests,
          ])}
          head="Browser"
          subs={browserOsSubs(devices)}
          title="Browsers"
        />
        <BreakdownSection
          empty="No OS data yet — visit the app URL, then reload."
          entries={devices.map((d): [string, number] => [
            d.os === "" ? "Unknown" : d.os,
            d.requests,
          ])}
          head="OS"
          title="Operating systems"
        />
        <BreakdownSection
          empty="No visited paths yet — browse the app, then reload."
          entries={paths.map((p): [string, number] => [p.path, p.requests])}
          head="Path"
          title="Paths"
        />
        <BreakdownSection
          empty="No referrer data yet — share a link to the app, then reload."
          entries={refs.map((r): [string, number] => [r.source, r.requests])}
          head="Source"
          title="Referrers"
        />
      </div>
    </>
  );
};

const MetricsDetailView = ({
  cpus,
  devices,
  errs,
  hasRows,
  hours,
  lats,
  loadError,
  loaded,
  paths,
  refs,
  reqs,
  spans,
  spansError,
}: {
  cpus: number[];
  devices: RunnerDevice[];
  errs: number[];
  hasRows: boolean;
  hours: number;
  lats: number[];
  loadError: string;
  loaded: boolean;
  paths: RunnerPath[];
  refs: RunnerRef[];
  reqs: number[];
  spans: RunnerSpan[];
  spansError: string;
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
        devices={devices}
        errs={errs}
        hours={hours}
        lats={lats}
        paths={paths}
        refs={refs}
        reqs={reqs}
        spans={spans}
        spansError={spansError}
      />
    ) : null}
  </>
);

/** Per-bucket totals over `keys` (oldest first): one pass over the rows, not
 * one filter per bucket — a 1-month window has 720 buckets. */
const totalsByBucket = (
  rows: MetricsFrame["metrics"],
  keys: string[],
  pick: (row: RunnerMetric) => number
): number[] => {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = row.bucketTs.slice(0, 13);
    totals.set(key, (totals.get(key) ?? 0) + pick(row));
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
  hours = DEFAULT_METRICS_HOURS,
  viewAllHref,
}: {
  appId: string;
  detail?: boolean;
  hours?: number;
  viewAllHref?: string;
}) => {
  // Usage over SSE: last snapshot (or skeleton when cold) until the first
  // frame, then the stream pushes a frame only when the request total moves.
  const feed = liveFeed(
    feedKeys.metrics(appId, hours),
    metricsUrl(appId, hours),
    decodeMetrics
  );
  // Read the frame (or its stored snapshot) directly: no copy into atoms,
  // so a revisit paints the last numbers in the very first render.
  const rows = (): MetricsFrame["metrics"] => feed.latest()?.metrics ?? [];
  const spans = (): MetricsFrame["spans"] => feed.latest()?.spans ?? [];
  const devices = (): NonNullable<MetricsFrame["devices"]> =>
    feed.latest()?.devices ?? [];
  const paths = (): NonNullable<MetricsFrame["paths"]> =>
    feed.latest()?.paths ?? [];
  const refs = (): NonNullable<MetricsFrame["refs"]> =>
    feed.latest()?.refs ?? [];
  const spansError = atom("");
  const loaded = (): boolean =>
    feed.latest() !== undefined || feed.status() === "open";
  const loadError = (): string =>
    feed.status() === "retrying" ? "Usage stream disconnected — retrying…" : "";
  const pickers = {
    cpuMs: (r: RunnerMetric) => r.cpuMs,
    errors: (r: RunnerMetric) => r.errors,
    latency: (r: RunnerMetric) => r.latencyMs,
    requests: (r: RunnerMetric) => r.requests,
  };
  const keys = hourKeys(hours);
  const totalByHour = (kind: keyof typeof pickers) =>
    totalsByBucket(rows(), keys, pickers[kind]);
  const reqs = totalByHour("requests");
  const cpus = totalByHour("cpuMs");
  const errs = totalByHour("errors");
  const lats = totalByHour("latency");
  const totalReq = sum(reqs);
  const totalErr = rows().reduce((a, r) => a + r.errors, 0);
  const totalCpu = sum(cpus);
  const totalLat = rows().reduce((a, r) => a + r.latencyMs, 0);
  return (
    <>
      {detail ? (
        <MetricsDetailView
          cpus={cpus}
          devices={devices()}
          errs={errs}
          hasRows={rows().length > 0}
          hours={hours}
          lats={lats}
          loadError={loadError()}
          loaded={loaded()}
          paths={paths()}
          refs={refs()}
          reqs={reqs}
          spans={spans()}
          spansError={spansError()}
        />
      ) : (
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <div class="flex items-center justify-between gap-2">
              <h3 class="m-0 flex items-center gap-2 text-lg font-semibold">
                Metrics · {windowLabel(hours)}
                <span
                  class="tooltip tooltip-bottom sm:tooltip-right inline-flex opacity-60"
                  data-tip={`What celld OTel recorded · ${windowLabel(hours)}: request/cell-fetch/startup spans, execution ms, failed spans, and queued time. Errors come from the trace \`ok\` flag.`}
                >
                  <Info />
                </span>
              </h3>
              {viewAllHref && !detail ? (
                <a href={viewAllHref} class="btn btn-sm">
                  View All
                </a>
              ) : null}
            </div>
            {loadError() ? (
              <p class="text-error m-0 text-sm">{loadError()}</p>
            ) : null}
            {!loaded() && rows().length === 0 && !loadError() ? (
              <div
                role="status"
                aria-label="Loading usage"
                class="flex flex-col gap-2"
              >
                <div class="skeleton h-4 w-64" />
                <div class="skeleton h-16 w-full" />
              </div>
            ) : null}
            {loaded() && rows().length === 0 && !loadError() ? (
              <p class="m-0 text-sm opacity-70">
                No traffic recorded yet — hit the app URL to see requests and
                CPU.
              </p>
            ) : (
              <>
                <BarRow
                  hours={hours}
                  keys={keys}
                  label="Requests (fetch spans)"
                  values={reqs}
                  max={Math.max(1, ...reqs)}
                />
                <p class="m-0 text-sm opacity-80">
                  {totalReq} requests · {totalErr} errors ·{" "}
                  {totalCpu.toLocaleString()} ms CPU ·{" "}
                  {(totalLat / 1000).toFixed(1)} s latency
                </p>
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
};
