import { isInstanceAdmin } from "../lib/collaborators";
import { controlAccessRefusal } from "../lib/server/control-d1.server";
import { getSessionOrNull, requestOrigin } from "../lib/server/session.server";

/** Pure decision half of the control stream gate: the status and message a
 * `_control` stream answers with, or null to proceed. Signed out is 401;
 * impersonated or not an instance admin is 403 (the same policy as the
 * control D1, `lib/server/control-d1.server`). Exported for the unit test. */
export const controlStreamRefusalDecision = (access: {
  signedIn: boolean;
  impersonatedBy: string | null;
  isAdmin: boolean;
}): { status: 401 | 403; message: string } | null => {
  if (!access.signedIn) {
    return { message: "Sign in required", status: 401 };
  }
  const refusal = controlAccessRefusal(access);
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
  const session = await getSessionOrNull(request, env).catch(() => null);
  const user = session?.user;
  const isAdmin =
    user !== undefined &&
    session?.impersonatedBy === null &&
    (await isInstanceAdmin(user.id, user.email));
  const refusal = controlStreamRefusalDecision({
    impersonatedBy: session?.impersonatedBy ?? null,
    isAdmin,
    signedIn: user !== undefined,
  });
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
  const session = await getSessionOrNull(request, env).catch(() => null);
  return session?.user.id;
};
