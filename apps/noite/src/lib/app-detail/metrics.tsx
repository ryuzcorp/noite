//! Usage charts: 24h request/CPU bars + spans table.
import { atom, unsafe, watch } from "ilha";

import type { RunnerMetric, RunnerSpan } from "../runner";
import { readSwrCache, writeSwrCache } from "../swr-cache";
import { INFO_SVG } from "./icons";

const hourKeys = () =>
  Array.from({ length: 24 }, (_, i) =>
    new Date(Date.now() - (23 - i) * 3_600_000).toISOString().slice(0, 13)
  );

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

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
    <div class="flex h-16 items-end gap-px">
      {values.map((v, i) => (
        <div
          class="bg-primary/70 min-w-1 flex-1 rounded-t"
          style={{ height: `${Math.max(2, Math.round((v / max) * 100))}%` }}
          title={`${hourKeys()[i]} · ${v}`}
        />
      ))}
    </div>
  </div>
);

const MetricsDetailCards = ({
  cpus,
  errs,
  lats,
  reqs,
  spans,
  spansError,
}: {
  cpus: number[];
  errs: number[];
  lats: number[];
  reqs: number[];
  spans: RunnerSpan[];
  spansError: string;
}) => (
  <>
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
            label="Latency ms (execution)"
            values={lats}
            max={Math.max(1, ...lats)}
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
                    <th class="text-right">queued</th>
                  </tr>
                </thead>
                <tbody>
                  {spans.map((s) => (
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
  </>
);

const MetricsDetailView = ({
  cpus,
  errs,
  hasRows,
  lats,
  loadError,
  loaded,
  reqs,
  spans,
  spansError,
}: {
  cpus: number[];
  errs: number[];
  hasRows: boolean;
  lats: number[];
  loadError: string;
  loaded: boolean;
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
        errs={errs}
        lats={lats}
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
  const rows = atom<RunnerMetric[]>(seedRows ?? []);
  const spans = atom<RunnerSpan[]>(seedSpans ?? []);
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
        const { metrics, spans: freshSpans } = frame as {
          metrics?: unknown;
          spans?: unknown;
        };
        if (!Array.isArray(metrics) || !Array.isArray(freshSpans)) {
          return;
        }
        // SAFETY: metrics passed Array.isArray above; rows mirror the retired unary action shape.
        rows.set(metrics as RunnerMetric[]);
        // SAFETY: freshSpans passed Array.isArray above; entries flow only into usage rendering.
        spans.set(freshSpans as RunnerSpan[]);
        writeSwrCache(`app:${appId}:metrics`, metrics);
        writeSwrCache(`app:${appId}:spans`, freshSpans);
        loadError.set("");
        spansError.set("");
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
          errs={errs}
          hasRows={rows().length > 0}
          lats={lats}
          loadError={loadError()}
          loaded={loaded()}
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
