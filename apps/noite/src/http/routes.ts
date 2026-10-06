import { FindMyWay } from "effect/http";
import * as Schema from "effect/Schema";
import type { FetchHandler } from "oxidejs";

import { authFromEnv, MissingAuthSecretError } from "../lib/auth";
import {
  isInstanceAdmin,
  listAppsForCollaborator,
  parseAppRole,
  requireAppRole,
  requireAppRoleBySlug,
} from "../lib/collaborators";
import { CONTROL_APP_ID, CONTROL_BUILD } from "../lib/control-app";
import { controlAccessRefusal } from "../lib/control-d1.server";
import { ensureDbPromise } from "../lib/db";
import { INVITES_PER_USER, signupPolicy } from "../lib/invites.server";
import {
  clientKey,
  DEFAULT_RPM,
  limitedClass,
  rateLimitDecision,
  withTrustedClientAddress,
} from "../lib/rate-limit";
import {
  findRecoveryEmail,
  RECOVERY_CODE_TTL_SECONDS,
} from "../lib/recovery.server";
import type {
  RunnerDevice,
  RunnerMetric,
  RunnerPath,
  RunnerRef,
  RunnerSpan,
} from "../lib/runner";
import { RUNNER_DEFAULT_URL, stampRunnerEnv } from "../lib/runner";

type RouteHandler = (
  request: Request,
  env: KitEnv,
  params?: Record<string, string | undefined>
) => Response | undefined | Promise<Response | undefined>;

/** Deployment generation marker, stamped at build time (`vite.config.ts`
 * defines it from the git sha) so adoption is verifiable — `/health` exposes
 * it — without anyone remembering to bump a number. Without this, worker-code
 * version is indistinguishable from outside and every diagnosis branches.
 * (The marker itself lives in lib/control-app.ts so the control-app detail
 * page can show it too.) */
const handleHealth: RouteHandler = () =>
  Response.json({ build: CONTROL_BUILD, ok: true, service: "noite-control" });

/** Runner base URL + bearer token from the control env (undefined when
 * the token is missing). */
const runnerConfig = (
  kit: KitEnv
): { runner: string; token: string } | undefined => {
  const token = kit.RUNNER_TOKEN ?? "";
  if (!token) {
    return undefined;
  }
  const runner = (kit.RUNNER_URL ?? RUNNER_DEFAULT_URL).replace(/\/$/u, "");
  return { runner, token };
};

const runnerTokenOk = (request: Request, env: KitEnv): boolean => {
  const expected = env.RUNNER_TOKEN ?? "";
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

/** Largest JSON body the machine routes (`/webhook`, ingest) will read.
 * Events, identifies and insights are a few hundred bytes; this only bounds
 * what one caller can make the worker buffer. */
const MAX_BODY_BYTES = 256 * 1024;

/** Read a request body as text, refusing (null) anything over `max` bytes —
 * by the declared length first, then by counting what actually arrives so a
 * missing or lying `content-length` cannot slip past. */
export const readBoundedText = async (
  request: Request,
  max: number
): Promise<string | null> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    return null;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be counted in arrival order
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    received += value.byteLength;
    if (received > max) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- stop the upload as soon as it is over the bound
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
};

const tooLarge = (): Response =>
  new Response("request body too large", { status: 413 });

/** Optional nudge path — prefer the runner's own webhook; this proxy is for
 * deploy.sh convenience. It adds no authority: the caller must already hold
 * the runner token, and only the body and content type are forwarded (never
 * the caller's cookies or other headers). */
const handleWebhook: RouteHandler = async (request, env) => {
  if (!runnerTokenOk(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const body = await readBoundedText(request, MAX_BODY_BYTES);
  if (body === null) {
    return tooLarge();
  }
  return fetch(`${rc.runner}/webhook`, {
    body,
    headers: {
      authorization: `Bearer ${rc.token}`,
      "content-type":
        request.headers.get("content-type") ?? "application/octet-stream",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
};

/** Public signup policy for the login panel: is a code required? Answered
 * without a session (the panel asks before anyone can sign in), carries no
 * account data. A broken check must not block the UI, so it answers with the
 * stricter policy on failure. */
const handleInviteStatus: RouteHandler = async () => {
  await ensureDbPromise();
  try {
    return Response.json(await signupPolicy());
  } catch {
    return Response.json({
      firstRun: false,
      invitesPerUser: INVITES_PER_USER,
      requiresInvite: true,
    });
  }
};

const RecoveryBody = Schema.Struct({ email: Schema.optional(Schema.String) });

/** Operator escape hatch (`noite-runner recover`): mint a sign-in code for an
 * account without sending it anywhere, for an operator who lost the passkey
 * and has no email webhook. The caller must hold the runner token — whoever
 * can run a command in the container — and the code goes through the same
 * "Lost passkey?" sign-in as an emailed one: it expires, allows few attempts,
 * and lands on the account page to enrol a new passkey. */
const handleRecovery: RouteHandler = async (request, env) => {
  if (!runnerTokenOk(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }
  const text = await readBoundedText(request, MAX_BODY_BYTES);
  if (text === null) {
    return tooLarge();
  }
  let raw: unknown;
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return Response.json({ error: "invalid json", ok: false }, { status: 400 });
  }
  const decoded = Schema.decodeUnknownResult(RecoveryBody)(raw);
  if (decoded._tag === "Failure") {
    return Response.json(
      { error: "email must be a string", ok: false },
      { status: 400 }
    );
  }
  await ensureDbPromise();
  const email = await findRecoveryEmail(decoded.success.email);
  if (!email) {
    return Response.json(
      {
        error: decoded.success.email
          ? `no active account for ${decoded.success.email}`
          : "no admin account exists yet: open the control UI and sign up first",
        ok: false,
      },
      { status: 404 }
    );
  }
  try {
    const auth = authFromEnv(env, new URL(request.url).origin);
    const code = await auth.api.createVerificationOTP({
      body: { email, type: "sign-in" },
    });
    return Response.json(
      { code, email, expiresInSeconds: RECOVERY_CODE_TTL_SECONDS, ok: true },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return Response.json(
        { error: error.message, ok: false },
        { status: 500 }
      );
    }
    throw error;
  }
};

const handleAuth: RouteHandler = async (request, env) => {
  await ensureDbPromise();
  try {
    const auth = authFromEnv(env, new URL(request.url).origin);
    return await auth.handler(withTrustedClientAddress(request));
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }
    throw error;
  }
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

/** Pure decision half of the control stream gate: the status and message a
 * `_control` stream answers with, or null to proceed. Signed out is 401;
 * impersonated or not an instance admin is 403 (the same policy as the
 * control D1, `lib/control-d1.server`). Exported for the unit test. */
export const controlStreamRefusalDecision = (access: {
  signedIn: boolean;
  impersonatedBy: string | null;
  isAdmin: boolean;
}): { status: 401 | 403; message: string } | null => {
  if (!access.signedIn) {
    return { message: "Sign in required", status: 401 };
  }
  const refusal = controlAccessRefusal(access);
  return refusal === null ? null : { message: refusal, status: 403 };
};

/** Control-plane stream gate for the reserved `_control` app: a real instance
 * admin, never an impersonated session — the pseudo app has no collaborator
 * role to check (mirrors `requireControlAdmin` in lib/apps.server). Returns
 * the refusal response, or undefined when the caller may proceed. */
const controlStreamRefusal = async (
  request: Request,
  env: KitEnv
): Promise<Response | undefined> => {
  let origin: string;
  try {
    ({ origin } = new URL(request.url));
  } catch {
    return new Response("bad request", { status: 400 });
  }
  let session;
  try {
    const auth = authFromEnv(env, env.BETTER_AUTH_URL ?? origin);
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    return new Response("Sign in required", { status: 401 });
  }
  const user = session?.user;
  // The admin plugin adds an optional impersonatedBy id to sessions it
  // creates; presence means this session is impersonated (lib/apps.server).
  const impersonatedBy = session?.session?.impersonatedBy
    ? String(session.session.impersonatedBy)
    : null;
  const isAdmin =
    user !== undefined &&
    impersonatedBy === null &&
    (await isInstanceAdmin(user.id, user.email));
  const refusal = controlStreamRefusalDecision({
    impersonatedBy,
    isAdmin,
    signedIn: user !== undefined,
  });
  return refusal === null
    ? undefined
    : new Response(refusal.message, { status: refusal.status });
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

/** Content types a browser renders as a document: served inline like the
 * rest, but under a sandbox, so a direct visit to the proxy URL cannot run
 * the script an uploaded object might carry. */
const SANDBOXED_R2_TYPES = {
  "application/xhtml+xml": true,
  "application/xml": true,
  "image/svg+xml": true,
  "text/html": true,
  "text/xml": true,
} satisfies Record<string, true>;

/** Path params + key query for an R2 object route (undefined when bad). */
const r2ObjectTarget = (
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

/** Fetch one raw R2 object from the runner and re-serve it to the browser
 * with the object's own media type (the UI renders images through this URL
 * and offers it as the download link), unreachable-by-script headers for the
 * dangerous types, and no sniffing. The body streams through, so a large
 * download shows progress instead of hanging into the platform deadline. */
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
  const type = (res.headers.get("content-type") ?? "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const headers = new Headers();
  headers.set("content-type", type || "application/octet-stream");
  headers.set(
    "content-disposition",
    `inline; filename="${filename.replaceAll('"', "_")}"`
  );
  headers.set("x-content-type-options", "nosniff");
  if (Object.hasOwn(SANDBOXED_R2_TYPES, type)) {
    headers.set("content-security-policy", "sandbox");
  }
  return new Response(res.body, { headers, status: res.status });
};

/** Browser upload for one R2 object: session + push gate, then stream the
 * body to the runner (which spools it and calls `celld r2 put`, so the
 * stored record is what a Worker's `env.BUCKET.put()` writes). Nothing
 * buffers the file — the browser's body is handed to fetch as it arrives. */
const handleR2Upload: RouteHandler = async (request, env, params) => {
  const target = r2ObjectTarget(request, params);
  if (!target) {
    return new Response("app, bucket, and key required", { status: 400 });
  }
  await ensureDbPromise();
  const userId = await routeUserId(request, env);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(target.appId, userId, "push");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const upstream =
    `${rc.runner}/v1/apps/${encodeURIComponent(target.appId)}` +
    `/storage/r2/${encodeURIComponent(target.bucket)}/object` +
    `?key=${encodeURIComponent(target.key)}`;
  // Node/undici require `duplex: "half"` for a streamed request body; workerd
  // takes the stream either way and ignores the member (RequestInit has no
  // field for it, hence the widened local).
  const init: RequestInit & { duplex?: "half" } = {
    body: request.body,
    duplex: "half",
    headers: {
      authorization: `Bearer ${rc.token}`,
      "content-type":
        request.headers.get("content-type") ?? "application/octet-stream",
    },
    method: "PUT",
  };
  const res = await fetch(upstream, init);
  return new Response(await res.text(), {
    headers: { "content-type": "application/json" },
    status: res.status,
  });
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
  const body = await readBoundedText(request, MAX_BODY_BYTES);
  if (body === null) {
    return tooLarge();
  }
  const upstream = await fetch(
    `${rc.runner}/v1/apps/${encodeURIComponent(appId)}/${kind}`,
    {
      body,
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
  const target = r2ObjectTarget(request, params);
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
const handleLogsStream: RouteHandler = (request, env, params) =>
  proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/logs/stream`
  );

/** Response for a hand-rolled SSE stream. */
const sseResponse = (stream: ReadableStream): Response => {
  const headers = new Headers();
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  return new Response(stream, { headers });
};

/** Sleep `ms`, waking early when `signal` aborts. The abort listener is
 * removed on every exit path: a long-lived stream sleeps once per cycle, and
 * a listener left behind each time would pile up on `request.signal` for as
 * long as the tab stays open. */
export const sleepUnlessAborted = (
  ms: number,
  signal: AbortSignal
): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- abortable sleep; Effect.sleep takes no abort signal
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const wake = () => {
      // oxlint-disable-next-line eslint/no-use-before-define -- the timer and the abort listener each cancel the other
      clearTimeout(timer);
      signal.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal.addEventListener("abort", wake, { once: true });
  });

/** Close a stream controller the client may already have cancelled. */
const closeQuietly = (controller: ReadableStreamDefaultController): void => {
  try {
    controller.close();
  } catch {
    // Already closed by the client going away.
  }
};

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
const handleMetricsStream: RouteHandler = async (request, env, params) => {
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
const handleDeploysStream: RouteHandler = (request, env, params) =>
  proxyRunnerStream(
    request,
    env,
    params,
    (appId) => `/v1/apps/${appId}/deploys/stream`
  );

/** Live grouped-errors proxy (see proxyRunnerStream). `?status=` passes
 * through; the runner validates it. */
const handleErrorsStream: RouteHandler = (request, env, params) => {
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
router.on("POST", "/internal/recovery", handleRecovery);
router.on("GET", "/storage/:appId/r2/:bucket/raw", handleR2Raw);
router.on("PUT", "/storage/:appId/r2/:bucket/upload", handleR2Upload);
router.on("GET", "/api/apps/:appId/logs/stream", handleLogsStream);
router.on("GET", "/api/apps/:appId/deploys/stream", handleDeploysStream);
router.on("GET", "/api/apps/:appId/events/stream", handleEventsStream);
router.on("GET", "/api/apps/:appId/errors/stream", handleErrorsStream);
router.on("GET", "/api/apps/stream", handleAppsStream);
router.on("GET", "/api/apps/:appId/metrics/stream", handleMetricsStream);
router.on("POST", "/api/apps/:appId/ingest/:kind", forwardIngest);
router.on("GET", "/api/invite/status", handleInviteStatus);
router.all("/api/auth", handleAuth);
router.all("/api/auth/*", handleAuth);

/** The `src/server.ts` fetch handler (also driven directly by the tests). */
export const handleHttp = ((request, env) => {
  // SAFETY: the Worker env carries every KitEnv control key the handlers need; unset keys stay undefined as handlers tolerate.
  const kit = env as KitEnv;
  // Edge routes never enter oxide's ALS, so hand the real runner credentials
  // to the fetch path before any handler runs.
  stampRunnerEnv(kit);
  let pathname: string;
  try {
    const { pathname: p } = new URL(request.url);
    pathname = p;
  } catch {
    // Malformed URL — no route can match, let the platform 404.
    return;
  }
  // Platform rate limit for the public routes: a flood is refused here, before
  // it reaches better-auth or D1. `NOITE_RATE_LIMIT_RPM=0` disables it.
  const klass = limitedClass(pathname);
  if (klass) {
    const rpm = Number(kit.NOITE_RATE_LIMIT_RPM ?? DEFAULT_RPM);
    const decision = rateLimitDecision(
      `${klass}:${clientKey(request)}`,
      Number.isFinite(rpm) ? rpm : DEFAULT_RPM,
      Date.now()
    );
    if (!decision.allowed) {
      return new Response("Too many requests", {
        headers: {
          "retry-after": String(decision.retryAfter),
          "x-ratelimit-remaining": "0",
        },
        status: 429,
      });
    }
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
