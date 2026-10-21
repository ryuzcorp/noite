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

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets, for `Retry-After`. */
  retryAfter: number;
  remaining: number;
}

/** One independent set of rate-limit buckets: decisions never touch another
 * instance's counters, so attacker-chosen keys cannot evict platform buckets
 * no matter how many distinct keys arrive. */
export interface RateLimiter {
  decision: (key: string, limit: number, now: number) => RateLimitDecision;
  reset: () => void;
}

/** A limiter with its own bucket store. Pure decision + bookkeeping per key,
 * split out so the logic is exercisable without a Request. */
export const createRateLimiter = (): RateLimiter => {
  const buckets = new Map<string, Bucket>();

  const decision = (
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
        for (const [entryKey, entry] of buckets) {
          if (entry.resetAt <= now) {
            buckets.delete(entryKey);
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

  return {
    decision,
    reset: () => {
      buckets.clear();
    },
  };
};

/** The platform limiter behind the 04 middleware (per client IP, one budget
 * per route class): a request refused here never reaches better-auth, its
 * own limiter, or D1. */
export const platformLimiter = createRateLimiter();

/** The envelope handler's own per-key limiter: its keys come from the
 * attacker's `sentry_key`, so they live in a store of their own and can
 * never evict platform buckets. */
export const envelopeLimiter = createRateLimiter();

/** Client identity for the counter: the RIGHT-most forwarded address. Caddy
 * appends the peer it actually saw to whatever `X-Forwarded-For` the client
 * sent, so the left-most entries are client-controlled (rotating them would
 * mint a fresh bucket per request) while the last one is the trusted hop's
 * word. Falls back to `cf-connecting-ip`, then a shared bucket, so a direct
 * hit still counts somewhere. */
export const clientKey = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    const last = forwarded.split(",").at(-1)?.trim();

    if (last) {
      return last;
    }
  }

  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
};

/** The request with `X-Forwarded-For` collapsed to the one trusted address
 * ({@link clientKey}). better-auth reads the FIRST entry of that header for
 * its own per-IP limiter, so handing it the raw header would let a client
 * pick its own bucket. */
export const withTrustedClientAddress = (request: Request): Request => {
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-for", clientKey(request));

  return new Request(request, { headers });
};

/** The Sentry envelope endpoint, slash-less and slash variants: the 04
 * middleware runs before the trailing-slash alias, so both spellings land
 * in the same per-IP class. */
const ENVELOPE_PATH = /^\/api\/\d+\/envelope\/?$/u;

/** Route classes the platform limiter covers, each with its own budget so a
 * busy class cannot starve the other. Auth is included on purpose: a request
 * rejected here never reaches better-auth, its own limiter, or D1. The
 * envelope endpoint is included per client IP (before its own per-key
 * check): a random key per request still shares the sender's IP bucket. */
export const limitedClass = (pathname: string): string | null => {
  if (pathname === "/api/invite/status") {
    return "invite";
  }

  if (pathname === "/internal/recovery") {
    return "recovery";
  }

  if (ENVELOPE_PATH.test(pathname)) {
    return "envelope";
  }

  return pathname.startsWith("/api/auth") ? "auth" : null;
};
