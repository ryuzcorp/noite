/**
 * Noite Void-compatibility proxy worker (celld `main` entry).
 *
 * One runner-owned script cohosted in each Void app's fleet (celld `services`).
 * Serves `POST /revalidate`, `POST /email/send` and `POST /ai/*` to the tenant
 * app over its in-fleet `__VOID_PROXY` service binding. The proxy is never
 * publicly routable.
 *
 * Deploy: this file is the celld `main` entry; celld bundles the `.ts` entry
 * with esbuild at deploy, so no build step is needed. It imports `./src/*`,
 * which the runner copies alongside it verbatim and renders the `Env` vars
 * documented in SPEC.md ("Void platform proxy"). Tests and test helpers
 * never ship.
 *
 * This file is the router plus the default export; handlers live in `src/`.
 * Portions ported from the Void project (MIT License — see the attribution
 * note in SPEC.md "Void platform proxy") carry their attribution in the
 * module where they live.
 *
 * Globals used: `fetch`, `crypto`, KV bindings, `cloudflare:sockets`, and
 * `caches.default` for the ISR edge purge (`CELLD_CACHE_SCOPE=deployment`
 * shares one cache across the fleet's deployment, like a Cloudflare zone, so
 * the proxy deletes the app's L1 entries alongside the KV keys). The proxy
 * only ever deletes edge entries — it never `put`s, `match`es or `open`s,
 * so it holds no cached state of its own.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { handleAiProvider, handleAiRun, readAiModelMap } from "./src/ai.ts";
import {
  asString,
  isRecord,
  json,
  readRequestJson,
  RequestBodyError,
  requestBodyMaxBytes,
  timingSafeEqual,
} from "./src/auth.ts";
import { handleEmailSend } from "./src/email/send.ts";
import { readSenderDomain } from "./src/email/validate.ts";
import type { Env, ProxyDeps } from "./src/env.ts";
import { handleRevalidate } from "./src/revalidate.ts";

const POST_ROUTES = new Set([
  "/revalidate",
  "/email/send",
  "/email/relay",
  "/ai/run",
  "/ai/provider",
  "/ai/models",
  "/ai/toMarkdown",
]);

const handleHealth = (env: Env): Response => {
  const smtpHost = (env.VOID_PROXY_SMTP_HOST ?? "").trim();

  return json({
    bindings: {
      ai: env.VOID_PROXY_AI_ENABLED === "1",
      aiRun:
        readAiModelMap(env) !== null &&
        Object.keys(readAiModelMap(env) ?? {}).length > 0,
      email: smtpHost.length > 0,
      emailDomain: readSenderDomain(env) !== null,
      isrCache: !!env.ISR_CACHE,
      mailKv: !!env.MAIL_IDEMPOTENCY,
    },
    ok: true,
  });
};

/**
 * Service-binding auth only (the proxy is not publicly routable, so Void's
 * JWT/HTTPS path is dropped): per-fleet token equality plus a `projectId` pin
 * against the proxy's own configured id. The token is tenant-visible, which is
 * harmless — isolation comes from the transport (service bindings resolve only
 * within the fleet process), not from the token.
 */
const authenticateProxyRequest = (
  env: Env,
  body: Record<string, unknown>
): { projectId: string } | { response: Response } => {
  const projectId = asString(body.projectId);
  const aiToken = asString(body.aiToken);

  if (!projectId || !aiToken) {
    return { response: json({ error: "projectId and aiToken required" }, 400) };
  }

  const expectedProjectId = env.__PROJECT_ID;
  const expectedToken = env.__VOID_PROXY_TOKEN;

  if (!expectedProjectId || !expectedToken) {
    return { response: json({ error: "proxy not configured" }, 500) };
  }

  if (
    projectId !== expectedProjectId ||
    !timingSafeEqual(aiToken, expectedToken)
  ) {
    return { response: json({ error: "invalid project token" }, 403) };
  }

  return { projectId };
};

/**
 * Proxy entry point. `deps` injects the platform edges (sockets, upstream
 * fetch, timeouts) for tests; production passes none.
 */
export const handleFetch = async (
  request: Request,
  env: Env,
  deps: ProxyDeps = {}
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    return handleHealth(env);
  }

  if (!POST_ROUTES.has(path)) {
    return json({ error: "not found" }, 404);
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // The former relay endpoint is gone. Reject it before auth so an untrusted
  // MIME stream is never parsed or buffered here.
  if (path === "/email/relay") {
    return json({ error: "not found" }, 404);
  }

  let parsed: unknown;

  try {
    parsed = await readRequestJson(request, requestBodyMaxBytes(path));
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: "invalid JSON body" }, 400);
  }

  if (!isRecord(parsed)) {
    return json({ error: "invalid JSON body" }, 400);
  }

  const body = parsed;
  const auth = authenticateProxyRequest(env, body);

  if ("response" in auth) {
    return auth.response;
  }

  const { projectId } = auth;

  // Per-group capability gates.
  if (path.startsWith("/email/")) {
    if ((env.VOID_PROXY_SMTP_HOST ?? "").trim().length === 0) {
      return json({ error: "email not configured" }, 501);
    }

    return handleEmailSend(env, body, projectId, deps);
  }

  if (path.startsWith("/ai/")) {
    if (env.VOID_PROXY_AI_ENABLED !== "1") {
      return json({ error: "ai not configured" }, 501);
    }

    switch (path) {
      case "/ai/provider": {
        return handleAiProvider(body, deps);
      }

      case "/ai/run": {
        return handleAiRun(env, body, deps);
      }

      case "/ai/models":
      case "/ai/toMarkdown": {
        return json(
          {
            error: "not available",
            message:
              "This operation requires the Workers AI binding, which Noite does not provide.",
          },
          501
        );
      }

      default: {
        return json({ error: "not found" }, 404);
      }
    }
  }

  return handleRevalidate(env, body, deps);
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
};
