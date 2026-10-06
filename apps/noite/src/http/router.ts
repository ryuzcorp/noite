import { FindMyWay } from "effect/http";
import type { FetchHandler } from "oxidejs";

import {
  clientKey,
  DEFAULT_RPM,
  limitedClass,
  rateLimitDecision,
} from "../lib/rate-limit";
import { stampRunnerEnv } from "../lib/runner";
import type { RouteHandler } from "./config";
import { handleAuth, handleInviteStatus } from "./routes/auth";
import { handleHealth } from "./routes/health";
import { forwardIngest } from "./routes/ingest";
import {
  handleGitAuth,
  handleRecovery,
  handleTelemetryFacts,
  handleWebhook,
} from "./routes/internal";
import { handleR2Raw, handleR2Upload } from "./routes/r2";
import {
  handleAppsStream,
  handleDeploysStream,
  handleErrorsStream,
  handleEventsStream,
  handleLogsStream,
  handleMetricsStream,
} from "./routes/streams";

const router = FindMyWay.make<RouteHandler>();
router.all("/health", handleHealth);
router.on("POST", "/webhook", handleWebhook);
router.on("POST", "/internal/git-auth", handleGitAuth);
router.on("POST", "/internal/recovery", handleRecovery);
router.on("GET", "/internal/telemetry-facts", handleTelemetryFacts);
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
