/** Built-in rate limiting for the worker's public routes.
 *
 * better-auth limits `/api/auth/*` itself; this is the coarser platform
 * backstop for every public, unauthenticated path (`/api/auth/*` and
 * `/api/invite/status`), so a flood cannot reach the auth library or the D1
 * query behind the signup-policy route at all.
 *
 * The counter lives in the worker isolate: with one control node a request
 * lands on the same isolate most of the time, and celld already serialises a
 * cell's work. That makes this a practical abuse bound, not a
 * load-balancer-grade quota — the edge (`caddy`) has no rate limiter, and a
 * real deployment can add one in front.
 */

const WINDOW_MS = 60_000;

/** Default requests per window per client, per route class, per isolate.
 * Sized for the UI (a page load costs a handful of requests, and the login
 * page polls its session while the cookie settles), not for a browser tab
 * that hammers an endpoint in a loop. */
export const DEFAULT_RPM = 600;

/** Buckets are per client key; the map is capped so a wide attack cannot grow
 * it without bound (oldest entries drop first). */
const MAX_BUCKETS = 4096;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets, for `Retry-After`. */
  retryAfter: number;
  remaining: number;
}

/** Pure decision + bookkeeping for one key. Split out so the logic is
 * exercisable without a Request. */
export const rateLimitDecision = (
  key: string,
  limit: number,
  now: number
): RateLimitDecision => {
  if (limit <= 0) {
    return { allowed: true, remaining: 0, retryAfter: 0 };
  }
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      // Drop everything already expired, then give up on the oldest entry.
      for (const [k, v] of buckets) {
        if (v.resetAt <= now) {
          buckets.delete(k);
        }
      }
      const oldest = buckets.keys().next();
      if (!oldest.done) {
        buckets.delete(oldest.value);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfter: 0 };
};

/** Client identity for the counter: the left-most forwarded address when the
 * proxy chain supplies one (Caddy always does), else the peer-less fallback so
 * a direct hit still counts somewhere. */
export const clientKey = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",", 1)[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
};

/** Route classes the platform limiter covers, each with its own budget so a
 * busy class cannot starve the other. Auth is included on purpose: a request
 * rejected here never reaches better-auth, its own limiter, or D1. */
export const limitedClass = (pathname: string): string | null => {
  if (pathname === "/api/invite/status") {
    return "invite";
  }
  return pathname.startsWith("/api/auth") ? "auth" : null;
};

/** Test seam: forget every counter. */
export const resetRateLimits = (): void => {
  buckets.clear();
};
