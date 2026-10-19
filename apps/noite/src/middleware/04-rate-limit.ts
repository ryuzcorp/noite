/**
 * Platform rate limit for the public routes (what `handleHttp` enforced
 * before the Void routes slice): a flood is refused here, before it reaches
 * better-auth or D1. `NOITE_RATE_LIMIT_RPM=0` disables it.
 */
import { defineMiddleware } from "void";

import {
  clientKey,
  DEFAULT_RPM,
  limitedClass,
  rateLimitDecision,
} from "../lib/rate-limit";

export default defineMiddleware((c, next) => {
  const klass = limitedClass(c.req.path);
  if (klass) {
    // SAFETY: the limiter reads only the string control keys off the Worker env.
    const kit = c.env as KitEnv;
    const rpm = Number(kit.NOITE_RATE_LIMIT_RPM ?? DEFAULT_RPM);
    const decision = rateLimitDecision(
      `${klass}:${clientKey(c.req.raw)}`,
      Number.isFinite(rpm) ? rpm : DEFAULT_RPM,
      Date.now()
    );
    if (!decision.allowed) {
      return Promise.resolve(
        new Response("Too many requests", {
          headers: {
            "retry-after": String(decision.retryAfter),
            "x-ratelimit-remaining": "0",
          },
          status: 429,
        })
      );
    }
  }
  return next();
});
