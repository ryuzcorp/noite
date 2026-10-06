import * as Schema from "effect/Schema";
import { fail, useEnv, useRequest } from "oxidejs";

import {
  authFromEnv,
  MissingAuthSecretError,
  UnauthorizedError,
} from "../auth";
import type { SessionUser } from "../auth";
import { isInstanceAdmin, requireAppRole } from "../collaborators";
import { ensureDbPromise } from "../db";
import { controlAccessRefusal } from "./control-d1.server";

/** The error union every session-gated action declares: a caller is either
 * signed out or the instance has no usable auth secret. */
export const AuthError = Schema.Union([
  UnauthorizedError,
  MissingAuthSecretError,
]);

/** The raw better-auth user plus the impersonation marker. */
export interface RequestSession {
  impersonatedBy: string | null;
  user: { email: string; id: string; name: string; role?: unknown };
}

/** new URL() throws on malformed input — never let a bad request URL 500. */
export const requestOrigin = (request: Request): string | undefined => {
  try {
    return new URL(request.url).origin;
  } catch {
    return undefined;
  }
};

/** One session read shared by actions and HTTP routes: returns null instead
 * of throwing for a missing or unreadable session, so each caller picks its
 * own status/failure semantics. A missing auth secret still escapes — that is
 * a deployment fault, not a signed-out caller. */
export const getSessionOrNull = async (
  request: Request,
  env: KitEnv
): Promise<RequestSession | null> => {
  await ensureDbPromise();
  const origin = requestOrigin(request);
  if (!origin) {
    return null;
  }
  // authFromEnv throws MissingAuthSecretError on a misconfigured instance; the
  // session read below is the only part that reads as "signed out".
  const auth = authFromEnv(env, origin);
  let session;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    return null;
  }
  const user = session?.user;
  if (!user) {
    return null;
  }
  // The admin plugin adds an optional impersonatedBy id to sessions it
  // creates; presence means this session is impersonated.
  const impersonatedBy = session?.session?.impersonatedBy;
  return {
    impersonatedBy: impersonatedBy ? String(impersonatedBy) : null,
    user,
  };
};

export const sessionUser = async (): Promise<SessionUser> => {
  const request = useRequest();
  const env = useEnv<KitEnv>() ?? process.env;
  // SAFETY: the ALS env (or process.env fallback) provides the same KitEnv
  // control keys used by every action.
  const session = await getSessionOrNull(request, env as KitEnv);
  if (!session) {
    throw new UnauthorizedError({ message: "Sign in required" });
  }
  return {
    email: session.user.email,
    id: session.user.id,
    impersonatedBy: session.impersonatedBy,
    name: session.user.name,
  };
};

/** Ownership gate for view-gated reads — the runner is the data source. */
export const requireViewApp = async (appId: string): Promise<void> => {
  const user = await sessionUser();
  await requireAppRole(appId, user.id, "view");
};

/** Gate for every control-D1 action: a REAL instance admin (the `admin` role
 * or the `NOITE_ADMIN_EMAIL` anchor) and never an impersonated session — an
 * admin touring as another user must not read or write the auth database.
 * Re-checked on every call, not only when the card renders. */
export const requireControlAdmin = async (): Promise<SessionUser> => {
  const user = await sessionUser();
  // Skip the admin lookup on an impersonated session: it is refused anyway.
  const isAdmin =
    user.impersonatedBy === null &&
    (await isInstanceAdmin(user.id, user.email));
  const refusal = controlAccessRefusal({
    impersonatedBy: user.impersonatedBy,
    isAdmin,
  });
  if (refusal !== null) {
    fail(refusal);
  }
  return user;
};
