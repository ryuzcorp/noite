//! Usage-stats polling shared by the metrics stream and its snapshot action.
//!
//! The stream (`http/routes/streams.ts`) and the `metricsFrame` action
//! (`lib/server/metrics.server.ts`) assemble the same frame the same way;
//! the poll helpers live here so neither side reaches into the other's
//! module. `METRICS_WINDOWS_HOURS` is the single source for the windows both
//! sides serve (a second `Set` here would drift).
import type {
  RunnerDevice,
  RunnerMetric,
  RunnerPath,
  RunnerRef,
  RunnerSpan,
} from "./runner";

/** Windows the metrics endpoints serve, in hours, for every series
 * (requests, spans, devices, paths, refs): 24 h, 7 d, and 1 month, within
 * the runner's telemetry retention (720 h). Anything else falls back to the
 * first. */
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
  envQuery = ""
): Promise<number> => {
  const versionQuery = envQuery === "" ? "" : `?${envQuery.slice(1)}`;

  const vRes = await fetch(`${base}/metrics/version${versionQuery}`, {
    headers: auth,
  });

  if (!vRes.ok) {
    return Number.NaN;
  }

  const vJson: unknown = await vRes.json();
  // SAFETY: cast validates at the fetch boundary; missing/non-numeric coerces to NaN.
  const record = vJson as { version?: string | number | null } | null;

  return Number(record?.version);
};

/** One 5-call metrics poll: null when the request total hasn't moved.
 * Also reused by the metrics frame action (the stream's initial snapshot). */
export const pollMetricsFrame = async (
  poll: MetricsPoll,
  lastTotal: number
): Promise<{ frame: string; total: number } | null> => {
  const { auth, base, windowQuery } = poll;

  const [mRes, sRes, dRes, pRes, rRes] = await Promise.all([
    fetch(`${base}/metrics?${windowQuery}`, { headers: auth }),
    fetch(`${base}/spans?${windowQuery}`, { headers: auth }),
    fetch(`${base}/devices?${windowQuery}`, { headers: auth }),
    fetch(`${base}/paths?${windowQuery}`, { headers: auth }),
    fetch(`${base}/refs?${windowQuery}`, { headers: auth }),
  ]);

  if (!mRes.ok || !sRes.ok || !dRes.ok || !pRes.ok || !rRes.ok) {
    throw new Error(
      `runner metrics ${mRes.status}/${sRes.status}/${dRes.status}/${pRes.status}/${rRes.status}`
    );
  }

  const [mJson, sJson, dJson, pJson, rJson]: unknown[] = await Promise.all([
    mRes.json(),
    sRes.json(),
    dRes.json(),
    pRes.json(),
    rRes.json(),
  ]);

  if (
    !Array.isArray(mJson) ||
    !Array.isArray(sJson) ||
    !Array.isArray(dJson) ||
    !Array.isArray(pJson) ||
    !Array.isArray(rJson)
  ) {
    throw new TypeError("runner metrics sent invalid data");
  }

  // SAFETY: mJson passed Array.isArray above; rows match the retired unary action shape.
  const metrics = mJson as RunnerMetric[];
  // SAFETY: sJson passed Array.isArray above; entries flow only into the SSE frame.
  const spans = sJson as RunnerSpan[];
  // SAFETY: dJson passed Array.isArray above; entries flow only into the SSE frame.
  const devices = dJson as RunnerDevice[];
  // SAFETY: pJson passed Array.isArray above; entries flow only into the SSE frame.
  const paths = pJson as RunnerPath[];
  // SAFETY: rJson passed Array.isArray above; entries flow only into the SSE frame.
  const refs = rJson as RunnerRef[];
  const total = metrics.reduce((a, r) => a + r.requests, 0);

  if (total === lastTotal) {
    return null;
  }

  return {
    frame: JSON.stringify({ devices, metrics, paths, refs, spans }),
    total,
  };
};
