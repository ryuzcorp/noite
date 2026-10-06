import {
  listAppsForCollaborator,
  requireAppRole,
} from "../../lib/collaborators";
import { CONTROL_APP_ID } from "../../lib/control-app";
import { ensureDbPromise } from "../../lib/db";
import type {
  RunnerDevice,
  RunnerMetric,
  RunnerPath,
  RunnerRef,
  RunnerSpan,
} from "../../lib/runner";
import { runnerConfig } from "../config";
import type { RouteHandler } from "../config";
import { controlStreamRefusal, routeUserId } from "../session";
import { closeQuietly, sleepUnlessAborted, sseResponse } from "../sse";

/** Runner SSE proxy shared by the log tail and deploy history streams:
 * session + view-role gate, then pipe the runner events (the browser
 * never sees RUNNER_TOKEN). */
const proxyRunnerStream = async (
  request: Request,
  env: KitEnv,
  params: Record<string, string | undefined> | undefined,
  upstreamPath: (appId: string) => string
): Promise<Response> => {
  const appId = params?.appId?.trim() ?? "";
  if (!appId) {
    return new Response("app required", { status: 400 });
  }
  await ensureDbPromise();
  if (appId === CONTROL_APP_ID) {
    // The control plane's own telemetry: instance admin, never impersonating.
    const refusal = await controlStreamRefusal(request, env);
    if (refusal) {
      return refusal;
    }
  } else {
    const userId = await routeUserId(request, env);
    if (!userId) {
      return new Response("Sign in required", { status: 401 });
    }
    try {
      await requireAppRole(appId, userId, "view");
    } catch {
      return new Response("forbidden", { status: 403 });
    }
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const upstream = await fetch(
    `${rc.runner}${upstreamPath(encodeURIComponent(appId))}`,
    {
      headers: { authorization: `Bearer ${rc.token}` },
      // T1.2: a browser leaving aborts this proxy, which must abort the
      // runner request too — otherwise the runner loop only notices on its
      // next change-send and can poll forever.
      signal: request.signal,
    }
  );
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => upstream.statusText);
    return new Response(text, { status: upstream.status });
  }
  const headers = new Headers();
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  return new Response(upstream.body, { headers, status: upstream.status });
};

/** Live log tail proxy (see proxyRunnerStream). */
export const handleLogsStream: RouteHandler = (request, env, params) =>
  proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/logs/stream`
  );

/** App list snapshot poll cadence: change diffs push immediately, comment
 * heartbeats land well inside celld's ~60s idle-stream expiry. */
const APPS_STREAM_POLL_MS = 10_000;

/** App list over SSE (like DeployList). Unverified: whether an oxide stream
 * action's first frame arrives on celld — an earlier 0.5.x attempt hung with
 * no frame at all (before the per-request runtime fix), and proving it now
 * needs a celld node, which only the release image runs. SSE is also what
 * makes the heartbeats possible: an idle HTTP stream dies on celld's ~60 s
 * expiry, so this polls D1 here and pushes diffs, with comment heartbeats
 * resetting the expiry and EventSource auto-reconnect covering the rest.
 * Session-gated like every other browser route. */
export const handleAppsStream: RouteHandler = async (request, env) => {
  await ensureDbPromise();
  const userId = await routeUserId(request, env);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let last = "";
      let quiet = 0;
      while (!request.signal.aborted) {
        let json: string | null = null;
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- one poll per cycle; parallel polls would race change detection
          const apps = await listAppsForCollaborator(userId);
          json = JSON.stringify(apps);
        } catch (error) {
          // Transient failure: log it; the heartbeat below keeps the
          // stream alive and the next poll heals.
          console.error("apps stream poll failed", error);
        }
        if (json !== null && json !== last) {
          last = json;
          quiet = 0;
          controller.enqueue(encoder.encode(`data: ${json}\n\n`));
        } else {
          quiet += 1;
          if (quiet % 2 === 0) {
            controller.enqueue(encoder.encode(": ping\n\n"));
          }
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential abortable sleep between polls
        await sleepUnlessAborted(APPS_STREAM_POLL_MS, request.signal);
      }
      closeQuietly(controller);
    },
  });
  return sseResponse(stream);
};

/** Usage-stats poll cadence: the runner rolls minute buckets, so 30s
 * catches every change without hammering it. */
const METRICS_STREAM_POLL_MS = 30_000;

/** Windows the metrics stream serves, in hours, for every series (requests,
 * spans, devices, paths, refs): 24 h, 7 d, and 1 month, within the runner's telemetry retention
 * (720 h). Anything else falls back to the first. */
const METRICS_WINDOWS_HOURS = [24, 168, 720] as const;

/** `?hours=` → one of {@link METRICS_WINDOWS_HOURS}. */
export const metricsWindowHours = (request: Request): number => {
  const asked = Number(new URL(request.url).searchParams.get("hours"));
  return METRICS_WINDOWS_HOURS.find((hours) => hours === asked) ?? 24;
};

/** Runner change counter (spec T3.6): NaN when the check itself fails, so
 * the poll below runs instead of skipping. */
const pollMetricsVersion = async (
  base: string,
  auth: { authorization: string }
): Promise<number> => {
  const vRes = await fetch(`${base}/metrics/version`, { headers: auth });
  if (!vRes.ok) {
    return Number.NaN;
  }
  const vJson: unknown = await vRes.json();
  // SAFETY: cast validates at the fetch boundary; missing/non-numeric coerces to NaN.
  const record = vJson as { version?: string | number | null } | null;
  return Number(record?.version);
};

interface MetricsPoll {
  auth: { authorization: string };
  base: string;
  windowQuery: string;
}

/** One 5-call metrics poll: null when the request total hasn't moved. */
const pollMetricsFrame = async (
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

interface MetricsStreamOptions extends MetricsPoll {
  controller: ReadableStreamDefaultController;
  /** Pause between cycles, heartbeat included. */
  pollMs: number;
  signal: AbortSignal;
}

/** The metrics stream's poll loop: every cycle checks the runner's change
 * counter, polls the full frame only when it moved, then writes exactly one
 * SSE chunk (frame or heartbeat) and sleeps. Exported for the unit tests. */
export const streamMetrics = async (
  options: MetricsStreamOptions
): Promise<void> => {
  const { auth, base, controller, pollMs, signal, windowQuery } = options;
  const encoder = new TextEncoder();
  let lastReq = -1;
  let lastVersion: number | null = null;
  while (!signal.aborted) {
    let frame: string | null = null;
    try {
      // Cheap change check (spec T3.6): the runner bumps the per-app
      // version on every ingest with new rows. When it hasn't moved,
      // the whole 5-call poll is skipped — but the cycle still ends in
      // the heartbeat and sleep below (a bare `continue` here would spin
      // the loop with no pause).
      // oxlint-disable-next-line eslint/no-await-in-loop -- one sequential cycle per loop by design
      const v = await pollMetricsVersion(base, auth);
      const unchanged =
        !Number.isNaN(v) && lastVersion !== null && v === lastVersion;
      if (!unchanged) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one sequential cycle per loop by design
        const polled = await pollMetricsFrame(
          { auth, base, windowQuery },
          lastReq
        );
        // Remember the version only once its poll succeeded, so a failed
        // poll is retried next cycle instead of being skipped as "seen".
        if (!Number.isNaN(v)) {
          lastVersion = v;
        }
        if (polled !== null) {
          const { frame: nextFrame, total } = polled;
          lastReq = total;
          frame = nextFrame;
        }
      }
    } catch (error) {
      // Transient failure: log it; the heartbeat below keeps the
      // stream alive and the next poll heals.
      console.error("metrics stream poll failed", error);
    }
    if (frame === null) {
      // No change (or a failed poll): heartbeat every cycle — 30s
      // cadence stays well inside the ~60s idle-stream expiry.
      controller.enqueue(encoder.encode(": ping\n\n"));
    } else {
      controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential abortable sleep between polls
    await sleepUnlessAborted(pollMs, signal);
  }
  closeQuietly(controller);
};

/** Usage stats over SSE (like the apps stream): the runner only exposes
 * unary metrics/spans endpoints, so this polls them here and pushes one
 * frame only when the request total moves — minute buckets mean the rest
 * is noise. Comment heartbeats reset celld's ~60s idle-stream expiry;
 * EventSource auto-reconnect covers the rest. Session + view-role gated. */
export const handleMetricsStream: RouteHandler = async (
  request,
  env,
  params
) => {
  const appId = params?.appId?.trim() ?? "";
  if (!appId) {
    return new Response("app required", { status: 400 });
  }
  await ensureDbPromise();
  if (appId === CONTROL_APP_ID) {
    // The control plane's own telemetry: instance admin, never impersonating.
    const refusal = await controlStreamRefusal(request, env);
    if (refusal) {
      return refusal;
    }
  } else {
    const userId = await routeUserId(request, env);
    if (!userId) {
      return new Response("Sign in required", { status: 401 });
    }
    try {
      await requireAppRole(appId, userId, "view");
    } catch {
      return new Response("forbidden", { status: 403 });
    }
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const base = `${rc.runner}/v1/apps/${encodeURIComponent(appId)}`;
  const auth = { authorization: `Bearer ${rc.token}` };
  // One window for every series in the frame, so tiles, charts, spans and
  // analytics always describe the same period.
  const windowQuery = `hours=${metricsWindowHours(request)}`;
  const stream = new ReadableStream({
    start: (controller) =>
      streamMetrics({
        auth,
        base,
        controller,
        pollMs: METRICS_STREAM_POLL_MS,
        signal: request.signal,
        windowQuery,
      }),
  });
  return sseResponse(stream);
};

/** Live deploy history proxy (see proxyRunnerStream). */
export const handleDeploysStream: RouteHandler = (request, env, params) =>
  proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/deploys/stream`
  );

/** Live grouped-errors proxy (see proxyRunnerStream). `?status=` passes
 * through; the runner validates it. */
export const handleErrorsStream: RouteHandler = (request, env, params) => {
  const status = new URL(request.url).searchParams.get("status") ?? "open";
  return proxyRunnerStream(
    request,
    env,
    params,
    (appId) =>
      `/v1/apps/${appId}/errors/stream?status=${encodeURIComponent(status)}`
  );
};

/** Live event feed proxy (see proxyRunnerStream). Query (channel/limit)
 * passes through so the client scopes the snapshot server-side. */
export const handleEventsStream: RouteHandler = (request, env, params) => {
  const url = new URL(request.url);
  const query = url.search;
  return proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/events/stream${query}`
  );
};
