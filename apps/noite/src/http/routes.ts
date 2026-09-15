import * as Schema from "effect/Schema";
import { FindMyWay } from "effect/unstable/http";
import type { FetchHandler } from "oxidejs";

import { authFromEnv, MissingAuthSecretError } from "../lib/auth";
import {
  parseAppRole,
  requireAppRole,
  requireAppRoleBySlug,
} from "../lib/collaborators";
import { ensureDbPromise } from "../lib/db";

type RouteHandler = (
  request: Request,
  env: KitEnv,
  params?: Record<string, string | undefined>
) => Response | undefined | Promise<Response | undefined>;

const handleHealth: RouteHandler = () =>
  Response.json({ ok: true, service: "noite-control" });

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
  });
};

const handleAuth: RouteHandler = async (request, env) => {
  await ensureDbPromise();
  try {
    const auth = authFromEnv(
      // SAFETY: the request env always carries the control env keys KitEnv narrows onto; falling back to process.env only guards a hypothetical un-injected env.
      env ?? (process.env as KitEnv),
      new URL(request.url).origin
    );
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
      // SAFETY: same KitEnv / process.env contract as handleAuth.
      env ?? (process.env as KitEnv),
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
  return new Response(await res.arrayBuffer(), { headers });
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
  // SAFETY: same KitEnv/process.env contract as every other RouteHandler.
  const kit = env ?? (process.env as KitEnv);
  const userId = await routeUserId(request, kit);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(target.appId, userId, "view");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(kit);
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

/** Live log tail proxy: session + view-role gate, then pipe the runner SSE
 * (the browser never sees RUNNER_TOKEN). */
const handleLogsStream: RouteHandler = async (request, env, params) => {
  const appId = params?.appId?.trim() ?? "";
  if (!appId) {
    return new Response("app required", { status: 400 });
  }
  await ensureDbPromise();
  // SAFETY: same KitEnv/process.env contract as every other RouteHandler.
  const kit = env ?? (process.env as KitEnv);
  const userId = await routeUserId(request, kit);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(appId, userId, "view");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(kit);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const upstream = await fetch(
    `${rc.runner}/v1/apps/${encodeURIComponent(appId)}/logs/stream`,
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

const router = FindMyWay.make<RouteHandler>();
router.all("/health", handleHealth);
router.on("POST", "/webhook", handleWebhook);
router.on("POST", "/internal/git-auth", handleGitAuth);
router.on("GET", "/storage/:appId/r2/:bucket/raw", handleR2Raw);
router.on("GET", "/api/apps/:appId/logs/stream", handleLogsStream);
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
  // SAFETY: the env (or process.env fallback) provides the same KitEnv control keys handled by every RouteHandler.
  return match.handler(request, (env ?? process.env) as KitEnv, match.params);
}) satisfies FetchHandler<KitEnv>;
