//! Usage-stats polling shared by the metrics stream and its snapshot action.
//!
//! The stream (`http/routes/streams.ts`) and the `metricsFrame` action
//! (`lib/server/metrics.server.ts`) assemble the same frame the same way;
//! the poll helpers live here so neither side reaches into the other's
//! module. `METRICS_WINDOWS_HOURS` is the single source for the windows both
//! sides serve (a second `Set` here would drift).
import type { RunnerMetric } from "./runner";

/** Windows the metrics endpoint serves, in hours: 24 h, 7 d, and 1 month,
 * within the runner's telemetry retention (720 h). Anything else falls back
 * to the first. */
export const METRICS_WINDOWS_HOURS = [24, 168, 720] as const;

export interface MetricsPoll {
  auth: { authorization: string };
  base: string;
  /** "" for production, else `&environmentId=<id>` appended to the frame
   * queries and (as `?…`) to the version gate. */
  envQuery: string;
  windowQuery: string;
}

/** Runner change counter (spec T3.6): NaN when the check itself fails, so
 * the poll below runs instead of skipping. `envQuery` scopes the gate to
 * one preview environment, like the frame poll. Also reused by the metrics
 * frame action (the stream's initial snapshot). */
export const pollMetricsVersion = async (
  base: string,
  auth: { authorization: string },
  envQuery = "",
  /** The stream's signal: a dropped topic aborts its in-flight poll too. */
  signal?: AbortSignal
): Promise<number> => {
  const versionQuery = envQuery === "" ? "" : `?${envQuery.slice(1)}`;

  const vRes = await fetch(`${base}/metrics/version${versionQuery}`, {
    headers: auth,
    signal,
  });

  if (!vRes.ok) {
    return Number.NaN;
  }

  const vJson: unknown = await vRes.json();
  // SAFETY: cast validates at the fetch boundary; missing/non-numeric coerces to NaN.
  const record = vJson as { version?: string | number | null } | null;

  return Number(record?.version);
};

/** One metrics poll: null when the request total hasn't moved. The version
 * gate in the stream already skips unchanged windows, so this is the single
 * read behind a frame. Also reused by the metrics frame action (the stream's
 * initial snapshot). */
export const pollMetricsFrame = async (
  poll: MetricsPoll,
  lastTotal: number,
  /** The stream's signal: a dropped topic aborts its in-flight poll too. */
  signal?: AbortSignal
): Promise<{ frame: string; total: number } | null> => {
  const { auth, base, windowQuery } = poll;

  const res = await fetch(`${base}/metrics?${windowQuery}`, {
    headers: auth,
    signal,
  });

  if (!res.ok) {
    throw new Error(`runner metrics ${res.status}`);
  }

  const rows: unknown = await res.json();

  if (!Array.isArray(rows)) {
    throw new TypeError("runner metrics sent invalid data");
  }

  // SAFETY: rows passed Array.isArray above; each row is an hourly AppMetric.
  const metrics = rows as RunnerMetric[];
  const total = metrics.reduce((a, r) => a + r.requests, 0);

  if (total === lastTotal) {
    return null;
  }

  return { frame: JSON.stringify({ metrics }), total };
};
