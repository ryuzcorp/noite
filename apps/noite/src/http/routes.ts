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
import type {
  RunnerContainerStub,
  RunnerDevice,
  RunnerMetric,
  RunnerPath,
  RunnerRef,
  RunnerSpan,
} from "../lib/runner";
import { runnerContainerStub } from "../lib/runner";

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
    const verified = await auth.api.verifyApiKey({
      body: { key, permissions: { apps: ["manage"] } },
    });
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

/** Machine ingest for tenant apps (LogSnag-style event API): Bearer
 * profile API key + push role on the app, then forward the JSON body to
 * the runner untouched so validation errors pass through with their
 * status codes. External callers use the control origin + `/api` path
 * (api.* routes to the runner, which knows no API keys). */
const INGEST_KINDS = new Set(["events", "identify", "insights"]);
const forwardIngest: RouteHandler = async (request, env, params) => {
  const appId = params?.appId?.trim() ?? "";
  const kind = params?.kind?.trim() ?? "";
  if (!appId || !INGEST_KINDS.has(kind)) {
    return new Response(
      "app and endpoint (events|identify|insights) required",
      { status: 400 }
    );
  }
  const key = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer /u, "")
    .trim();
  if (!key) {
    return new Response("bearer token required", { status: 401 });
  }
  await ensureDbPromise();
  try {
    const auth = authFromEnv(
      env,
      env.BETTER_AUTH_URL ?? new URL(request.url).origin
    );
    const verified = await auth.api.verifyApiKey({
      body: { key, permissions: { events: ["push"] } },
    });
    if (!(verified.valid && verified.key?.referenceId)) {
      return new Response("invalid key", { status: 401 });
    }
    await requireAppRole(appId, verified.key.referenceId, "push");
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const upstream = await fetch(
    `${rc.runner}/v1/apps/${encodeURIComponent(appId)}/${kind}`,
    {
      body: await request.text(),
      headers: {
        authorization: `Bearer ${rc.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    }
  );
  return new Response(await upstream.text(), {
    headers: { "content-type": "application/json" },
    status: upstream.status,
  });
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
          const [mRes, sRes, dRes, pRes, rRes] = await Promise.all([
            fetch(`${base}/metrics?hours=24`, { headers: auth }),
            fetch(`${base}/spans?hours=1`, { headers: auth }),
            fetch(`${base}/devices?hours=24`, { headers: auth }),
            fetch(`${base}/paths?hours=24`, { headers: auth }),
            fetch(`${base}/refs?hours=24`, { headers: auth }),
          ]);
          if (!mRes.ok || !sRes.ok || !dRes.ok || !pRes.ok || !rRes.ok) {
            throw new Error(
              `runner metrics ${mRes.status}/${sRes.status}/${dRes.status}/${pRes.status}/${rRes.status}`
            );
          }
          const [mJson, sJson, dJson, pJson, rJson]: unknown[] =
            // oxlint-disable-next-line eslint/no-await-in-loop -- same single poll, bodies read together
            await Promise.all([
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
          if (total !== lastReq) {
            lastReq = total;
            frame = JSON.stringify({ devices, metrics, paths, refs, spans });
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

/** Live event feed proxy (see proxyRunnerStream). Query (channel/limit)
 * passes through so the client scopes the snapshot server-side. */
const handleEventsStream: RouteHandler = (request, env, params) => {
  const url = new URL(request.url);
  const query = url.search;
  return proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/events/stream${query}`
  );
};

const router = FindMyWay.make<RouteHandler>();
router.all("/health", handleHealth);
router.on("POST", "/webhook", handleWebhook);
router.on("POST", "/internal/git-auth", handleGitAuth);
router.on("GET", "/storage/:appId/r2/:bucket/raw", handleR2Raw);
router.on("GET", "/api/apps/:appId/logs/stream", handleLogsStream);
router.on("GET", "/api/apps/:appId/deploys/stream", handleDeploysStream);
router.on("GET", "/api/apps/:appId/events/stream", handleEventsStream);
router.on("GET", "/api/apps/stream", handleAppsStream);
router.on("GET", "/api/apps/:appId/metrics/stream", handleMetricsStream);
router.on("POST", "/api/apps/:appId/ingest/:kind", forwardIngest);
router.all("/api/auth", handleAuth);
router.all("/api/auth/*", handleAuth);

/** One cached tenant port per slug for container dispatch. */
interface EdgePort {
  listenPort: number;
}

let edgeCacheAt = 0;
const edgeCacheBySlug = new Map<string, EdgePort>();
const EDGE_CACHE_TTL_MS = 5000;

type DispatchTarget =
  | { kind: "local" }
  | { kind: "runner"; path: string }
  | { kind: "tenant"; slug: string };

/** Pure Host/path sort: platform hosts → runner 8080, slugs → tenant port. */
const dispatchTarget = (
  host: string,
  base: string,
  pathname: string
): DispatchTarget => {
  if (host === `api.${base}`) {
    return { kind: "runner", path: pathname };
  }
  if (host === `git.${base}`) {
    const path = pathname.startsWith("/v1/git/")
      ? pathname
      : `/v1/git${pathname.startsWith("/") ? "" : "/"}${pathname}`;
    return { kind: "runner", path };
  }
  if (pathname === "/v1/edge/tls-ask") {
    return { kind: "runner", path: pathname };
  }
  if (host === base || host === `app.${base}` || !host.endsWith(`.${base}`)) {
    return { kind: "local" };
  }
  const slug = host.slice(0, -(base.length + 1));
  const reserved = new Set(["api", "app", "git"]);
  if (!slug || slug.includes(".") || reserved.has(slug)) {
    return { kind: "local" };
  }
  return { kind: "tenant", slug };
};

const forwardVia = (
  stub: RunnerContainerStub,
  request: Request,
  host: string,
  search: string,
  targetPath: string
): Promise<Response> => {
  const headers = new Headers(request.headers);
  // Preserve the original Host for the runner fallback page (it renders
  // per-Host); the container URL would otherwise collapse it to `runner`.
  headers.set("x-forwarded-host", host);
  return stub.fetch(
    new Request(`http://runner${targetPath}${search}`, {
      body: request.body,
      // @ts-expect-error duplex required for streamed bodies in workers
      duplex: "half",
      headers,
      method: request.method,
    })
  );
};

const EdgeRoutePayload = Schema.Struct({
  listenPort: Schema.Number,
  slug: Schema.String,
});

const EdgeRoutesPayload = Schema.Struct({
  routes: Schema.optional(Schema.Array(EdgeRoutePayload)),
});

const refreshEdgeCache = async (
  stub: RunnerContainerStub,
  token: string
): Promise<void> => {
  const res = await stub.fetch(
    new Request("http://runner/v1/edge/routes", {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  if (!res.ok) {
    return;
  }
  const payload = Schema.decodeUnknownSync(EdgeRoutesPayload)(await res.json());
  edgeCacheBySlug.clear();
  for (const route of payload.routes ?? []) {
    if (Number.isInteger(route.listenPort)) {
      edgeCacheBySlug.set(route.slug, { listenPort: route.listenPort });
    }
  }
  edgeCacheAt = Date.now();
};

/** Host dispatch for RUNNER_TARGET=container (before path routing).
 *
 * Static Caddy → control:8090 → worker Host-dispatch → container port:
 * api./git./tls-ask → runner 8080; {slug}. → port lookup; apex/control →
 * existing asset/worker routes (undefined). Compose target skips entirely.
 */
const containerDispatch = async (
  request: Request,
  env: KitEnv
): Promise<Response | undefined> => {
  if (env.RUNNER_TARGET !== "container" || !env.RUNNER) {
    return undefined;
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(request.url);
  } catch {
    return undefined;
  }
  const { hostname: rawHost, pathname, search } = parsed;
  const hostname = rawHost.toLowerCase();
  const base = (env.BASE_DOMAIN ?? "localhost").toLowerCase();
  const stub = await runnerContainerStub(env);
  if (!stub) {
    return undefined;
  }
  const target = dispatchTarget(hostname, base, pathname);
  if (target.kind === "local") {
    return undefined;
  }
  if (target.kind === "runner") {
    return forwardVia(stub, request, hostname, search, target.path);
  }
  // Refresh the route table on miss + ~5 s TTL (mirrors the DO cache).
  const now = Date.now();
  if (
    now - edgeCacheAt > EDGE_CACHE_TTL_MS ||
    !edgeCacheBySlug.has(target.slug)
  ) {
    try {
      await refreshEdgeCache(stub, env.RUNNER_TOKEN ?? "");
    } catch {
      // Serve stale on failure; miss below falls through to fallback.
    }
  }
  const hit = edgeCacheBySlug.get(target.slug);
  if (hit) {
    return forwardVia(
      stub,
      request,
      hostname,
      search,
      `/${hit.listenPort}${pathname === "/" ? "/" : pathname}`
    );
  }
  return forwardVia(stub, request, hostname, search, "/v1/edge/fallback");
};

/** Shared by Server Entry (prod) and Vite DEV middleware. */
export const handleHttp = (async (request, env) => {
  // SAFETY: the Worker env carries every KitEnv control key the handlers need; unset keys stay undefined as handlers tolerate.
  const kit = env as KitEnv;
  let dispatched: Response | undefined;
  try {
    dispatched = await containerDispatch(request, kit);
  } catch {
    dispatched = undefined;
  }
  if (dispatched) {
    return dispatched;
  }
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
  return match.handler(request, kit, match.params);
}) satisfies FetchHandler<KitEnv>;
