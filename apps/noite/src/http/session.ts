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

/** Whether a signed-in account holds no access at all: waitlist-`pending` or
 * banned. Pure over the session's user row, so every browser route (streams,
 * source, R2, env previews) and the JSON-action gate refuse the same two
 * states at the same choke point instead of drifting. */
export const routeUserRefused = (
  user: { banned?: unknown; status?: unknown } | null | undefined
): boolean => !!user && (user.status === "pending" || user.banned === true);

/** Browser-route session gate: the user id when the caller may proceed, else
 * the refusal to answer with. Signed out is 401; a pending or banned account
 * is 403 — it holds no access at any gate, matching `sessionUser`'s refusal
 * for JSON actions (`lib/server/session.server`). */
export const routeGate = async (
  request: Request,
  env: KitEnv
): Promise<{ userId: string } | { response: Response }> => {
  const read = await readSession(request, env).catch(() => null);
  const user = read?._tag === "Session" ? read.session.user : undefined;

  if (!user) {
    return { response: new Response("Sign in required", { status: 401 }) };
  }

  if (routeUserRefused(user)) {
    return { response: new Response("forbidden", { status: 403 }) };
  }

  return { userId: user.id };
};
