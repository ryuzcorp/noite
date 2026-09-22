import { authClient } from "./auth-client";

type SessionResult = Awaited<ReturnType<typeof authClient.getSession>>;

/** Burst window: concurrent mounts and the readiness polls share one
 * request, so a cold landing costs a single /get-session instead of ~20. */
const BURST_TTL_MS = 2000;

let cached: { at: number; value: SessionResult } | null = null;
let inFlight: Promise<SessionResult> | null = null;

const loadSession = async (): Promise<SessionResult> => {
  try {
    const result = await authClient.getSession();
    cached = { at: Date.now(), value: result };
    return result;
  } finally {
    inFlight = null;
  }
};

const fetchFresh = (): Promise<SessionResult> => {
  if (!inFlight) {
    inFlight = loadSession();
  }
  return inFlight;
};
export const fetchSession = (opts?: {
  force?: boolean;
}): Promise<SessionResult> => {
  if (!opts?.force && cached && Date.now() - cached.at < BURST_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  return fetchFresh();
};

/** Drop the cached session after auth state changes outside a forced poll
 * (sign-out, stop-impersonating) so the next read can't see the old user.
 */
export const invalidateSession = (): void => {
  cached = null;
};
