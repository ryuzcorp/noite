//! Usage charts: 24h request/CPU bars + spans table.
import { atom, unsafe, watch } from "ilha";

import { formatHour } from "../dates";
import type {
  RunnerDevice,
  RunnerMetric,
  RunnerPath,
  RunnerRef,
  RunnerSpan,
} from "../runner";
import { readSwrCache, writeSwrCache } from "../swr-cache";
import { INFO_SVG } from "./icons";

// UTC hour-bucket keys (`2026-09-21T16`) matching the runner's UTC stamps.
// Display only — labels go through formatHour (viewer-local, no TZ).
const hourKeys = () =>
  Array.from({ length: 24 }, (_, i) =>
    new Date(Date.now() - (23 - i) * 3_600_000).toISOString().slice(0, 13)
  );

// First/last bucket labels for the axis. hourKeys always yields 24
// entries, so the fallbacks never render in practice.
const hourEnds = (): [string, string] => {
  const keys = hourKeys();
  return [formatHour(keys[0] ?? ""), formatHour(keys.at(-1) ?? "")];
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// Per-hour average from parallel totals/counts (zero where no traffic).
const perReqAvg = (totals: number[], counts: number[]) =>
  totals.map((t, i) => {
    const n = counts[i] ?? 0;
    return n > 0 ? t / n : 0;
  });

// Inline SVG lives here as a string: ilha mounts JSX in the HTML namespace,
// where <svg> elements never become real graphics (see the icon SVGs above
// using unsafe() for the same reason). All interpolated values are numbers
// or our own hour keys — no user input reaches the markup.
const barSvg = (values: number[], max: number): string => {
  const width = values.length * 10;
  const bars = values
    .map((v, i) => {
      const height = Math.max(1.5, (v / max) * 62).toFixed(1);
      const y = (64 - Number(height)).toFixed(1);
      const shown = Number.isInteger(v) ? `${v}` : v.toFixed(1);
      // Visible bar plus a transparent full-height capture rect painted
      // above it: hovering anywhere in the column (not just the green
      // fill) shows the hour/value tooltip. Transparent fill still takes
      // pointer events; fill="none" would not.
      return `<rect x="${i * 10 + 1}" y="${y}" width="8" height="${height}" rx="1.5" fill="currentColor"/><rect x="${i * 10}" y="0" width="10" height="64" fill="transparent"><title>${formatHour(hourKeys()[i] ?? "")} · ${shown}</title></rect>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 64" width="100%" height="100%" preserveAspectRatio="none" role="img"><line x1="0" y1="63.5" x2="${width}" y2="63.5" stroke="currentColor" stroke-width="1" opacity="0.25" vector-effect="non-scaling-stroke"/>${bars}</svg>`;
};

const BarRow = ({
  label,
  values,
  max,
}: {
  label: string;
  values: number[];
  max: number;
}) => (
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between text-xs opacity-80">
      <span>{label}</span>
      <span class="font-medium">{sum(values)}</span>
    </div>
    <div class="text-primary/70 block h-16 w-full">
      {unsafe(barSvg(values, max))}
    </div>
    <div class="flex justify-between text-[10px] opacity-60">
      <span>{hourEnds()[0]}</span>
      <span>{hourEnds()[1]}</span>
    </div>
  </div>
);

const StatTiles = ({
  cpus,
  errs,
  lats,
  reqs,
}: {
  cpus: number[];
  errs: number[];
  lats: number[];
  reqs: number[];
}) => {
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
    ["Requests", totalReq.toLocaleString(), "last 24h"],
    ["Error rate", errRate, `${totalErr.toLocaleString()} errors`],
    ["Avg latency", avgLat, "per request"],
    ["CPU time", cpu, "last 24h"],
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
  lats: number[];
  paths: RunnerPath[];
  refs: RunnerRef[];
  reqs: number[];
  spans: RunnerSpan[];
  spansError: string;
}) => (
  <>
    <StatTiles cpus={cpus} errs={errs} lats={lats} reqs={reqs} />
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <h3 class="m-0 text-lg font-semibold">Requests</h3>
          <BarRow
            label="Requests (fetch spans)"
            values={reqs}
            max={Math.max(1, ...reqs)}
          />
        </div>
      </section>
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <h3 class="m-0 text-lg font-semibold">Errors</h3>
          <BarRow
            label="Errors (failed spans)"
            values={errs}
            max={Math.max(1, ...errs)}
          />
        </div>
      </section>
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <h3 class="m-0 text-lg font-semibold">Latency</h3>
          <BarRow
            label="Avg latency ms per request"
            values={perReqAvg(lats, reqs)}
            max={Math.max(1, ...perReqAvg(lats, reqs))}
          />
        </div>
      </section>
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <h3 class="m-0 text-lg font-semibold">CPU</h3>
          <BarRow
            label="CPU ms (process)"
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
                        <td class="text-right">{s.qwaitMs.toLocaleString()}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {spans.length === 0 && !spansError ? (
            <p class="m-0 text-sm opacity-70">
              No spans in the last hour — spans reflect live fleet traces, not
              history.
            </p>
          ) : null}
        </div>
      </div>
    </section>
    <h3 class="m-0 text-lg font-semibold">Analytics</h3>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <BreakdownSection
        empty="No browser data yet — visit the app URL, then reload."
        entries={devices.map((d): [string, number] => [d.browser, d.requests])}
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

const MetricsDetailView = ({
  cpus,
  devices,
  errs,
  hasRows,
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

export const MetricsCard = ({
  appId,
  detail = false,
  viewAllHref,
}: {
  appId: string;
  detail?: boolean;
  viewAllHref?: string;
}) => {
  // Cache-first atoms: first paint carries last-good data on EVERY mount
  // (remount timing must never gate the paint); watch.once revalidates.
  const seedRows = readSwrCache<RunnerMetric[]>(`app:${appId}:metrics`);
  const seedSpans = readSwrCache<RunnerSpan[]>(`app:${appId}:spans`);
  const seedDevices = readSwrCache<RunnerDevice[]>(`app:${appId}:devices`);
  const seedPaths = readSwrCache<RunnerPath[]>(`app:${appId}:paths`);
  const seedRefs = readSwrCache<RunnerRef[]>(`app:${appId}:refs`);
  const rows = atom<RunnerMetric[]>(seedRows ?? []);
  const spans = atom<RunnerSpan[]>(seedSpans ?? []);
  const devices = atom<RunnerDevice[]>(seedDevices ?? []);
  const paths = atom<RunnerPath[]>(seedPaths ?? []);
  const refs = atom<RunnerRef[]>(seedRefs ?? []);
  const loadError = atom("");
  const spansError = atom("");
  // Loaded when a previous fetch settled — even an empty one — so
  // empty-but-fetched states skip the skeleton exactly like cached data.
  const loaded = atom(seedRows !== null);
  // Usage over SSE (like DeployList): cache-first seed paints instantly,
  // then the stream pushes a frame only when the request total moves.
  watch.once(() => {
    let stopped = false;
    const source = new EventSource(
      `/api/apps/${encodeURIComponent(appId)}/metrics/stream`
    );
    source.addEventListener("message", (event) => {
      // A frame arrived, so the stream is alive — mark loaded before
      // validation (a malformed frame must not stick the skeleton).
      loaded.set(true);
      try {
        const frame: unknown = JSON.parse(event.data);
        // SAFETY: frame shape is validated field-by-field below; non-objects fall through to the Array checks and return.
        const {
          devices: freshDevices,
          metrics,
          paths: freshPaths,
          refs: freshRefs,
          spans: freshSpans,
        } = frame as {
          devices?: unknown;
          metrics?: unknown;
          paths?: unknown;
          refs?: unknown;
          spans?: unknown;
        };
        if (!Array.isArray(metrics) || !Array.isArray(freshSpans)) {
          return;
        }
        // SAFETY: metrics passed Array.isArray above; rows mirror the retired unary action shape.
        rows.set(metrics as RunnerMetric[]);
        // SAFETY: freshSpans passed Array.isArray above; entries flow only into usage rendering.
        spans.set(freshSpans as RunnerSpan[]);
        // Devices, paths, and refs ride the same frame but stay optional:
        // older frames keep last-good data instead of clearing it.
        if (Array.isArray(freshDevices)) {
          // SAFETY: freshDevices passed Array.isArray above; entries flow only into usage rendering.
          devices.set(freshDevices as RunnerDevice[]);
          writeSwrCache(`app:${appId}:devices`, freshDevices);
        }
        if (Array.isArray(freshPaths)) {
          // SAFETY: freshPaths passed Array.isArray above; entries flow only into usage rendering.
          paths.set(freshPaths as RunnerPath[]);
          writeSwrCache(`app:${appId}:paths`, freshPaths);
        }
        if (Array.isArray(freshRefs)) {
          // SAFETY: freshRefs passed Array.isArray above; entries flow only into usage rendering.
          refs.set(freshRefs as RunnerRef[]);
          writeSwrCache(`app:${appId}:refs`, freshRefs);
        }
        writeSwrCache(`app:${appId}:metrics`, metrics);
        writeSwrCache(`app:${appId}:spans`, freshSpans);
      } catch {
        loadError.set("Usage stream sent invalid data");
      }
    });
    source.addEventListener("error", () => {
      if (!stopped) {
        loadError.set("Usage stream disconnected — retrying…");
      }
      loaded.set(true);
    });
    return () => {
      stopped = true;
      source.close();
    };
  });
  const pickers = {
    cpuMs: (r: RunnerMetric) => r.cpuMs,
    errors: (r: RunnerMetric) => r.errors,
    latency: (r: RunnerMetric) => r.latencyMs,
    requests: (r: RunnerMetric) => r.requests,
  };
  const totalByHour = (kind: keyof typeof pickers) =>
    hourKeys().map((key) =>
      sum(
        rows()
          .filter((r) => r.bucketTs.slice(0, 13) === key)
          .map(pickers[kind])
      )
    );
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
                Metrics · last 24h
                <span
                  class="tooltip tooltip-right inline-flex opacity-60"
                  data-tip="What celld OTel recorded · last hour: request/cell-fetch/startup spans, execution ms, failed spans, and queued time. Errors now come from the trace `ok` flag."
                >
                  {unsafe(INFO_SVG)}
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
