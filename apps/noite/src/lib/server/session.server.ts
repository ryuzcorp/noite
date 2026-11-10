import * as Schema from "effect/Schema";

import { sleepUnlessAborted } from "../../http/sse";
import { authFromEnv, UnauthorizedError } from "../auth";
import type { SessionUser } from "../auth";
import { authorityOf, mayAdministerInstance } from "../authority";
import type { InstanceAuthority } from "../authority";
import { isInstanceAdmin, requireAppRole } from "../collaborators";
import { ensureDb, resolveEnv } from "../db";
import { fail } from "./api";

/** The raw better-auth user plus the impersonation marker. `role` and
 * `banned` are the admin plugin's fields, unknown on purpose. */
export interface RequestSession {
  impersonatedBy: string | null;
  user: {
    banned?: unknown;
    email: string;
    id: string;
    name: string;
    role?: unknown;
  };
}

/** The session store could not answer (a read rejection or the bound below).
 * Distinct from `SignedOut` on purpose: an outage must not log a user out. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory (same pattern as lib/auth.ts)
export class SessionStoreUnavailableError extends Schema.TaggedError<SessionStoreUnavailableError>()(
  "SessionStoreUnavailableError",
  { message: Schema.String }
) {}

/** One closed type for "what is behind this request": no session, or this
 * session. A store outage is neither — it is thrown as
 * `SessionStoreUnavailableError`, so callers answer "retry" instead of
 * "sign in". */
export type SessionRead =
  | { readonly _tag: "SignedOut" }
  | { readonly _tag: "Session"; readonly session: RequestSession };

/** new URL() throws on malformed input — never let a bad request URL 500. */
export const requestOrigin = (request: Request): string | undefined => {
  try {
    return new URL(request.url).origin;
  } catch {
    return undefined;
  }
};

/** Bound on one session read. The store is D1 through better-auth (no
 * timeout anywhere in that chain), so a wedged store would otherwise ride
 * every action to the 15 s route timeout (flake H's 15.01 s pair). A miss
 * is `SignedOut`; a read that rejects or never answers throws
 * `SessionStoreUnavailableError`, so the action fails fast with cause
 * instead of hanging, and never logs the caller out over a stall. Tests
 * inject a small bound and await real signals, never a sleep. */
const SESSION_TIMEOUT_MS = 5000;

/** The one session read shared by actions and HTTP routes. A missing session
 * is `SignedOut`; a misconfigured instance throws `MissingAuthSecretError`
 * (a deployment fault, not a signed-out caller); a store that rejects or
 * never answers throws `SessionStoreUnavailableError`. */
export const readSession = async (
  request: Request,
  env: KitEnv,
  opts?: { timeoutMs?: number }
): Promise<SessionRead> => {
  await ensureDb();
  const origin = requestOrigin(request);

  if (!origin) {
    return { _tag: "SignedOut" };
  }

  // authFromEnv throws MissingAuthSecretError on a misconfigured instance; the
  // session read below is the only part that reads as "signed out".
  const auth = authFromEnv(env, origin);

  const read = (async () => {
    try {
      return await auth.api.getSession({ headers: request.headers });
    } catch (error) {
      throw new SessionStoreUnavailableError({
        message: `noite: session store read failed (${
          error instanceof Error ? error.message : String(error)
        })`,
      });
    }
  })();

  const timeoutMs = opts?.timeoutMs ?? SESSION_TIMEOUT_MS;
  const stop = new AbortController();

  const failAfter = (async (): Promise<null> => {
    await sleepUnlessAborted(timeoutMs, stop.signal);

    if (stop.signal.aborted) {
      // The read already won: the race settled, so this value is ignored.
      // Returning (not throwing) keeps a settled promise the race already
      // observes — no unhandled rejection from the losing branch.
      return null;
    }

    throw new SessionStoreUnavailableError({
      message: `noite: session store did not answer within ${timeoutMs}ms`,
    });
  })();

  let session;

  try {
    session = await Promise.race([read, failAfter]);
  } finally {
    stop.abort();
  }

  const user = session?.user;

  if (!user) {
    return { _tag: "SignedOut" };
  }

  // The admin plugin adds an optional impersonatedBy id to sessions it
  // creates; presence means this session is impersonated.
  const impersonatedBy = session?.session?.impersonatedBy;

  return {
    _tag: "Session",
    session: {
      impersonatedBy: impersonatedBy ? String(impersonatedBy) : null,
      user,
    },
  };
};

/** The active session, or null when signed out (the shape most callers want).
 * Store outages still throw — see `readSession`. */
export const getSessionOrNull = async (
  request: Request,
  env: KitEnv,
  opts?: { timeoutMs?: number }
): Promise<RequestSession | null> => {
  const read = await readSession(request, env, opts);

  return read._tag === "Session" ? read.session : null;
};

/** The session's authority, with the anchor promotion honoured: a session
 * minted before the anchored account was promoted still reads as an
 * instance admin (one D1 read, only in that case). */
const authorityOfSession = async (
  session: RequestSession
): Promise<InstanceAuthority> => {
  const { user } = session;

  const authority = authorityOf({
    adminEmail: resolveEnv().NOITE_ADMIN_EMAIL ?? null,
    banned: user.banned === true,
    email: user.email,
    impersonatedBy: session.impersonatedBy,
    role: user.role,
  });

  if (
    authority._tag === "Plain" &&
    (await isInstanceAdmin(user.id, user.email))
  ) {
    // The anchor was promoted in the database after this session was minted:
    // the row is the authority, not the stale session field.
    return authorityOf({
      adminEmail: resolveEnv().NOITE_ADMIN_EMAIL ?? null,
      email: user.email,
      impersonatedBy: session.impersonatedBy,
      role: "admin",
    });
  }

  return authority;
};

/** The instance-admin predicate for a session (one query at most). Exported
 * for the HTTP route gates that hold a `RequestSession` already. */
export const sessionAuthority = (
  session: RequestSession
): Promise<InstanceAuthority> => authorityOfSession(session);

export const sessionUser = async (
  request: Request,
  env: KitEnv
): Promise<SessionUser> => {
  const read = await readSession(request, env);

  if (read._tag === "SignedOut") {
    throw new UnauthorizedError({ message: "Sign in required" });
  }

  const { session } = read;

  return {
    authority: await authorityOfSession(session),
    email: session.user.email,
    id: session.user.id,
    impersonatedBy: session.impersonatedBy,
    name: session.user.name,
  };
};

/** Ownership gate for view-gated reads — the runner is the data source. */
export const requireViewApp = async (
  request: Request,
  env: KitEnv,
  appId: string
): Promise<void> => {
  const user = await sessionUser(request, env);
  await requireAppRole(appId, user.id, "view");
};

/** Gate for every control-D1 action: a REAL instance admin (the `admin` role
 * or the `NOITE_ADMIN_EMAIL` anchor) and never an impersonated session — an
 * admin touring as another user must not read or write the auth database.
 * Re-checked on every call, not only when the card renders. The predicate is
 * `authorityOf` (lib/authority), the same one `requireAdmin`, the control
 * stream gate and the client surfaces use. */
export const requireControlAdmin = async (
  request: Request,
  env: KitEnv
): Promise<SessionUser> => {
  const user = await sessionUser(request, env);

  if (!mayAdministerInstance(user.authority)) {
    fail(
      user.authority._tag === "Impersonating"
        ? "Impersonation refused"
        : "Admin only"
    );
  }

  return user;
};
