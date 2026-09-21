import * as Schema from "effect/Schema";
import { FindMyWay } from "effect/unstable/http";
import type { FetchHandler } from "oxidejs";

import { authFromEnv, MissingAuthSecretError } from "../lib/auth";
import {
  listAppsForCollaborator,
  parseAppRole,
  requireAppRole,
  requireAppRoleBySlug,
  withLiveRunner,
} from "../lib/collaborators";
import { ensureDbPromise, withDb } from "../lib/db";
import type { RunnerMetric, RunnerSpan } from "../lib/runner";

type RouteHandler = (
  request: Request,
  env: KitEnv,
  params?: Record<string, string | undefined>
) => Response | undefined | Promise<Response | undefined>;

/** Deployment generation marker: bump on every `celld deploy` so adoption
 * is verifiable (`/health` exposes it). Without this, worker-code version
 * is indistinguishable from outside and every diagnosis branches. */
const CONTROL_BUILD = 18;

const handleHealth: RouteHandler = () =>
  Response.json({ build: CONTROL_BUILD, ok: true, service: "noite-control" });

/** Optional nudge path — prefer runner webhook; proxy for deploy.sh convenience. */
const handleWebhook: RouteHandler = async (request, env) => {
  const token = env.RUNNER_TOKEN ?? env.HOST_TOKEN ?? env.AGENT_TOKEN ?? "";
  if (!token) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const runner = (
    env.RUNNER_URL ??
    env.HOST_URL ??
    env.AGENT_URL ??
    "http://runner:8080"
  ).replace(/\/$/u, "");
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${runner}/webhook`, {
    body: await request.arrayBuffer(),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
};

const handleAuth: RouteHandler = async (request, env) => {
  await ensureDbPromise();
  try {
    const auth = authFromEnv(env, new URL(request.url).origin);
    return auth.handler(request);
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }
    throw error;
  }
};

const runnerTokenOk = (request: Request, env: KitEnv): boolean => {
  const expected = env.RUNNER_TOKEN ?? env.HOST_TOKEN ?? env.AGENT_TOKEN ?? "";
  if (!expected) {
    return false;
  }
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
  const header =
    request.headers.get("x-runner-token") ??
    request.headers.get("x-host-token") ??
    "";
  return bearer === expected || header === expected;
};

const GitAuthBody = Schema.Struct({
  key: Schema.String,
  need: Schema.optional(Schema.String),
  slug: Schema.String,
});

/** Runner → UI: verify profile API key + collaborator role for a slug. */
const handleGitAuth: RouteHandler = async (request, env) => {
  if (!runnerTokenOk(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid json", ok: false }, { status: 400 });
  }
  const decoded = Schema.decodeUnknownResult(GitAuthBody)(raw);
  if (decoded._tag === "Failure") {
    return Response.json(
      {
        error: "key, slug, and need (view|push|admin) required",
        ok: false,
      },
      { status: 400 }
    );
  }
  // decodeUnknownResult yields { _tag: "Success", success } — not `.value`.
  const key = decoded.success.key.trim();
  const slug = decoded.success.slug.trim();
  const need = parseAppRole(decoded.success.need?.trim() || "push");
  if (!(key && slug && need)) {
    return Response.json(
      {
        error: "key, slug, and need (view|push|admin) required",
        ok: false,
      },
      { status: 400 }
    );
  }
  await ensureDbPromise();
  try {
    const auth = authFromEnv(
      env,
      env.BETTER_AUTH_URL ?? new URL(request.url).origin
    );
    const verified = await auth.api.verifyApiKey({ body: { key } });
    if (!(verified.valid && verified.key?.referenceId)) {
      return Response.json(
        { error: "invalid key", ok: false },
        { status: 401 }
      );
    }
    const userId = verified.key.referenceId;
    const access = await requireAppRoleBySlug(slug, userId, need);
    return Response.json({
      appId: access.app.id,
      ok: true,
      role: access.role,
      userId,
    });
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }
    return Response.json({ error: "forbidden", ok: false }, { status: 403 });
  }
};

/** Session user id for browser routes (mirrors sessionUser in apps.server,
 * but returns undefined instead of throwing so routes pick their status). */
const routeUserId = async (
  request: Request,
  env: KitEnv
): Promise<string | undefined> => {
  let origin: string;
  try {
    ({ origin } = new URL(request.url));
  } catch {
    return undefined;
  }
  try {
    const auth = authFromEnv(env, env.BETTER_AUTH_URL ?? origin);
    const { user } =
      (await auth.api.getSession({ headers: request.headers })) ?? {};
    return user?.id;
  } catch {
    return undefined;
  }
};

/** Fetch one raw R2 object from the runner and re-serve it as a download. */
const proxyR2Object = async (
  runner: string,
  token: string,
  appId: string,
  bucket: string,
  key: string
): Promise<Response> => {
  const upstream =
    `${runner}/v1/apps/${encodeURIComponent(appId)}` +
    `/storage/r2/${encodeURIComponent(bucket)}/raw?key=${encodeURIComponent(key)}`;
  const res = await fetch(upstream, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return new Response(text, { status: res.status });
  }
  const filename = key.split("/").pop() ?? key;
  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set(
    "content-disposition",
    `attachment; filename="${filename.replaceAll('"', "_")}"`
  );
  // Stream the body through (never buffer): large downloads must show
  // progress, not hang into the platform deadline. Deliberately no total
  // timeout — only the headers below are awaited before responding.
  return new Response(res.body, { headers, status: res.status });
};

/** Path params + key query for the R2 download route (undefined when bad). */
const r2RawTarget = (
  request: Request,
  params?: Record<string, string | undefined>
): { appId: string; bucket: string; key: string } | undefined => {
  const appId = params?.appId?.trim() ?? "";
  const bucket = params?.bucket?.trim() ?? "";
  let key: string;
  try {
    key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  } catch {
    return undefined;
  }
  if (!(appId && bucket && key)) {
    return undefined;
  }
  return { appId, bucket, key };
};

/** Runner base URL + bearer token from the control env (undefined when
 * the token is missing). */
const runnerConfig = (
  kit: KitEnv
): { runner: string; token: string } | undefined => {
  const token = kit.RUNNER_TOKEN ?? kit.HOST_TOKEN ?? kit.AGENT_TOKEN ?? "";
  if (!token) {
    return undefined;
  }
  const runner = (
    kit.RUNNER_URL ??
    kit.HOST_URL ??
    kit.AGENT_URL ??
    "http://runner:8080"
  ).replace(/\/$/u, "");
  return { runner, token };
};

/** Browser download for one R2 object: session + view-role gate, then proxy
 * the runner's raw bytes (the browser never sees RUNNER_TOKEN). */
const handleR2Raw: RouteHandler = async (request, env, params) => {
  const target = r2RawTarget(request, params);
  if (!target) {
    return new Response("app, bucket, and key required", { status: 400 });
  }
  await ensureDbPromise();
  const userId = await routeUserId(request, env);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(target.appId, userId, "view");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  return proxyR2Object(
    rc.runner,
    rc.token,
    target.appId,
    target.bucket,
    target.key
  );
};

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
  const userId = await routeUserId(request, env);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(appId, userId, "view");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const upstream = await fetch(
    `${rc.runner}${upstreamPath(encodeURIComponent(appId))}`,
    { headers: { authorization: `Bearer ${rc.token}` } }
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
const handleLogsStream: RouteHandler = (request, env, params) =>
  proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/logs/stream`
  );

/** App list snapshot poll cadence: change diffs push immediately, comment
 * heartbeats land well inside celld's ~60s idle-stream expiry. */
const APPS_STREAM_POLL_MS = 10_000;

/** App list over SSE (like DeployList): the oxide stream action hangs (its
 * first frame never arrives) and idle HTTP streams die on celld's ~60s
 * expiry without reconnect — so this polls D1 here and pushes diffs, with
 * comment heartbeats resetting the expiry and EventSource auto-reconnect
 * covering the rest. Session-gated like every other browser route. */
const handleAppsStream: RouteHandler = async (request, env) => {
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
          const apps = await withDb(listAppsForCollaborator(userId));
          // oxlint-disable-next-line eslint/no-await-in-loop -- fans out this cycle's live overlays together
          const live = await Promise.all(
            apps.map((row) => withLiveRunner(row))
          );
          json = JSON.stringify(live);
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
        // oxlint-disable-next-line eslint/no-await-in-loop, promise/avoid-new -- sequential abortable sleep; Effect.sleep takes no abort signal
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, APPS_STREAM_POLL_MS);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      controller.close();
    },
  });
  const headers = new Headers();
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  return new Response(stream, { headers });
};

/** Usage-stats poll cadence: the runner rolls minute buckets, so 30s
 * catches every change without hammering it. */
const METRICS_STREAM_POLL_MS = 30_000;

/** Usage stats over SSE (like the apps stream): the runner only exposes
 * unary metrics/spans endpoints, so this polls them here and pushes one
 * frame only when the request total moves — minute buckets mean the rest
 * is noise. Comment heartbeats reset celld's ~60s idle-stream expiry;
 * EventSource auto-reconnect covers the rest. Session + view-role gated. */
const handleMetricsStream: RouteHandler = async (request, env, params) => {
  const appId = params?.appId?.trim() ?? "";
  if (!appId) {
    return new Response("app required", { status: 400 });
  }
  await ensureDbPromise();
  const userId = await routeUserId(request, env);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(appId, userId, "view");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const base = `${rc.runner}/v1/apps/${encodeURIComponent(appId)}`;
  const auth = { authorization: `Bearer ${rc.token}` };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let lastReq = -1;
      while (!request.signal.aborted) {
        let frame: string | null = null;
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- one poll per cycle; parallel polls would race change detection
          const [mRes, sRes] = await Promise.all([
            fetch(`${base}/metrics?hours=24`, { headers: auth }),
            fetch(`${base}/spans?hours=1`, { headers: auth }),
          ]);
          if (!mRes.ok || !sRes.ok) {
            throw new Error(`runner metrics ${mRes.status}/${sRes.status}`);
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- same single poll, bodies read together
          const [mJson, sJson]: unknown[] = await Promise.all([
            mRes.json(),
            sRes.json(),
          ]);
          if (!Array.isArray(mJson) || !Array.isArray(sJson)) {
            throw new TypeError("runner metrics sent invalid data");
          }
          // SAFETY: mJson passed Array.isArray above; rows match the retired unary action shape.
          const metrics = mJson as RunnerMetric[];
          // SAFETY: sJson passed Array.isArray above; entries flow only into the SSE frame.
          const spans = sJson as RunnerSpan[];
          const total = metrics.reduce((a, r) => a + r.requests, 0);
          if (total !== lastReq) {
            lastReq = total;
            frame = JSON.stringify({ metrics, spans });
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
        // oxlint-disable-next-line eslint/no-await-in-loop, promise/avoid-new -- sequential abortable sleep; Effect.sleep takes no abort signal
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, METRICS_STREAM_POLL_MS);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      controller.close();
    },
  });
  const out = new Headers();
  out.set("content-type", "text/event-stream");
  out.set("cache-control", "no-cache");
  out.set("connection", "keep-alive");
  return new Response(stream, { headers: out });
};

/** Live deploy history proxy (see proxyRunnerStream). */
const handleDeploysStream: RouteHandler = (request, env, params) =>
  proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/deploys/stream`
  );

const router = FindMyWay.make<RouteHandler>();
router.all("/health", handleHealth);
router.on("POST", "/webhook", handleWebhook);
router.on("POST", "/internal/git-auth", handleGitAuth);
router.on("GET", "/storage/:appId/r2/:bucket/raw", handleR2Raw);
router.on("GET", "/api/apps/:appId/logs/stream", handleLogsStream);
router.on("GET", "/api/apps/:appId/deploys/stream", handleDeploysStream);
router.on("GET", "/api/apps/stream", handleAppsStream);
router.on("GET", "/api/apps/:appId/metrics/stream", handleMetricsStream);
router.all("/api/auth", handleAuth);
router.all("/api/auth/*", handleAuth);

/** Shared by Server Entry (prod) and Vite DEV middleware. */
export const handleHttp = ((request, env) => {
  let pathname: string;
  try {
    const { pathname: p } = new URL(request.url);
    pathname = p;
  } catch {
    // Malformed URL — no route can match, let the platform 404.
    return;
  }
  // FindMyWay route lookup (method, path) — not Array.prototype.find.
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- router API
  const match = router.find(request.method, pathname);
  if (!match) {
    return;
  }
  // SAFETY: the Worker env carries every KitEnv control key the handlers need; unset keys stay undefined as handlers tolerate.
  return match.handler(request, env as KitEnv, match.params);
}) satisfies FetchHandler<KitEnv>;
