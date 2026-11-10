import { mayAdministerInstance } from "../lib/authority";
import type { InstanceAuthority } from "../lib/authority";
import { controlAccessRefusal } from "../lib/server/control-d1.server";
import {
  readSession,
  requestOrigin,
  sessionAuthority,
} from "../lib/server/session.server";

/** Pure decision half of the control stream gate: the status and message a
 * `_control` stream answers with, or null to proceed. Signed out is 401;
 * impersonated, banned or not an instance admin is 403 (the same policy as the
 * control D1, `lib/server/control-d1.server`). It reads the one authority
 * union (`lib/authority.ts`), never a hand-rolled role check, so the gate
 * cannot drift from `requireControlAdmin`. Exported for the unit test. */
export const controlStreamRefusalDecision = (
  authority: InstanceAuthority | null
): { status: 401 | 403; message: string } | null => {
  if (authority === null || authority._tag === "Anonymous") {
    return { message: "Sign in required", status: 401 };
  }

  const refusal = controlAccessRefusal({
    impersonatedBy: authority._tag === "Impersonating" ? authority.by : null,
    isAdmin: mayAdministerInstance(authority),
  });

  return refusal === null ? null : { message: refusal, status: 403 };
};

/** Control-plane stream gate for the reserved `_control` app: a real instance
 * admin, never an impersonated session — the pseudo app has no collaborator
 * role to check (mirrors `requireControlAdmin` in lib/server/session.server).
 * Returns the refusal response, or undefined when the caller may proceed. */
export const controlStreamRefusal = async (
  request: Request,
  env: KitEnv
): Promise<Response | undefined> => {
  if (!requestOrigin(request)) {
    return new Response("bad request", { status: 400 });
  }

  // One predicate: the session's authority folds role, the env anchor, the
  // ban flag and impersonation together (lib/server/session.server).
  const read = await readSession(request, env).catch(() => null);

  const authority =
    read?._tag === "Session" ? await sessionAuthority(read.session) : null;

  const refusal = controlStreamRefusalDecision(authority);

  return refusal === null
    ? undefined
    : new Response(refusal.message, { status: refusal.status });
};

/** Session user id for browser routes (mirrors sessionUser in
 * lib/server/session.server, but returns undefined instead of throwing so
 * routes pick their status). */
export const routeUserId = async (
  request: Request,
  env: KitEnv
): Promise<string | undefined> => {
  const read = await readSession(request, env).catch(() => null);

  return read?._tag === "Session" ? read.session.user.id : undefined;
};
