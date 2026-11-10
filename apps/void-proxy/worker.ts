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
 * Routing is one state machine (`src/routes.ts`): a request is a `Route`
 * (health, revalidate, email send, one of the AI operations, or the removed
 * relay tombstone), a 405, or a 404 — decided before the body is read.
 *
 * Globals used: `fetch`, `crypto`, KV bindings, `cloudflare:sockets`, and
 * `caches.default` for the ISR edge purge (`CELLD_CACHE_SCOPE=deployment`
 * shares one cache across the fleet's deployment, like a Cloudflare zone, so
 * the proxy deletes the app's L1 entries alongside the KV keys). The proxy
 * only ever deletes edge entries — it never `put`s, `match`es or `open`s,
 * so it holds no cached state of its own.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { handleAiProvider, handleAiRun } from "./src/ai.ts";
import {
  asString,
  assertNever,
  isRecord,
  json,
  readRequestJson,
  RequestBodyError,
  requestBodyMaxBytes,
  timingSafeEqual,
} from "./src/auth.ts";
import type { ProxyConfig } from "./src/config.ts";
import { readProxyConfig } from "./src/config.ts";
import { handleEmailSend } from "./src/email/send.ts";
import type { Env, ProxyDeps } from "./src/env.ts";
import { handleRevalidate } from "./src/revalidate.ts";
import { matchRoute } from "./src/routes.ts";

const handleHealth = (config: ProxyConfig): Response =>
  json({
    bindings: {
      ai: config.ai.enabled,
      aiRun:
        config.ai.models._tag === "Ready" &&
        Object.keys(config.ai.models.models).length > 0,
      // Agrees with what `readSmtpConfig` would accept, so a green probe can
      // never precede a 100 % send failure.
      email: config.email._tag === "Ready",
      emailDomain: config.senderDomain._tag === "Ready",
      isrCache: config.isr._tag === "Ready",
      mailKv: config.mailKv._tag === "Ready",
    },
    ok: true,
  });

/**
 * Service-binding auth only (the proxy is not publicly routable, so Void's
 * JWT/HTTPS path is dropped): per-fleet token equality plus a `projectId` pin
 * against the proxy's own configured id. The token is tenant-visible, which is
 * harmless — isolation comes from the transport (service bindings resolve only
 * within the fleet process), not from the token.
 *
 * States: `Authed` (the project id), or one refusal response — 400 (missing
 * or non-string credentials), 500 (proxy not configured), 403 (mismatch).
 * Every refusal is terminal; nothing is cached.
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

const AI_UNAVAILABLE = {
  error: "not available",
  message:
    "This operation requires the Workers AI binding, which Noite does not provide.",
};

/**
 * Proxy entry point. `deps` injects the platform edges (sockets, upstream
 * fetch, timeouts) for tests; production passes none.
 *
 * Order is the security contract: route decision → tombstone → bounded body
 * parse → auth → per-group capability gate → handler. `/email/relay` and any
 * other unknown path answer before auth so an untrusted payload is never
 * buffered.
 */
export const handleFetch = async (
  request: Request,
  env: Env,
  deps: ProxyDeps = {}
): Promise<Response> => {
  const url = new URL(request.url);
  const decision = matchRoute(url.pathname, request.method);

  if (decision._tag !== "Route") {
    return decision._tag === "MethodNotAllowed"
      ? json({ error: "method not allowed" }, 405)
      : json({ error: "not found" }, 404);
  }

  const { route } = decision;
  const config = readProxyConfig(env);

  if (route._tag === "Health") {
    return handleHealth(config);
  }

  if (route._tag === "Removed") {
    return json({ error: "not found" }, 404);
  }

  let parsed: unknown;

  try {
    parsed = await readRequestJson(request, requestBodyMaxBytes(url.pathname));
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

  switch (route._tag) {
    case "EmailSend": {
      if (config.email._tag === "Off") {
        return json({ error: "email not configured" }, 501);
      }

      return handleEmailSend(env, config, body, projectId, deps);
    }

    case "AiProvider": {
      if (!config.ai.enabled) {
        return json({ error: "ai not configured" }, 501);
      }

      return handleAiProvider(body, deps);
    }

    case "AiRun": {
      if (!config.ai.enabled) {
        return json({ error: "ai not configured" }, 501);
      }

      return handleAiRun(env, config.ai, body, deps);
    }

    case "AiUnavailable": {
      if (!config.ai.enabled) {
        return json({ error: "ai not configured" }, 501);
      }

      return json(AI_UNAVAILABLE, 501);
    }

    case "Revalidate": {
      return handleRevalidate(config.isr, body, deps);
    }

    default: {
      return assertNever(route);
    }
  }
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
};
