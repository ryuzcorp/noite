import { authFromEnv, MissingAuthSecretError } from "../../lib/auth";
import { ensureDb } from "../../lib/db";
import { withTrustedClientAddress } from "../../lib/rate-limit";
import {
  INVITES_PER_USER,
  signupPolicy,
} from "../../lib/server/invites.server";
import { ensureSetupCode } from "../../lib/server/setup-code.server";
import type { RouteHandler } from "../config";
import { routeFailure } from "../route-failure";

/** Public signup policy for the login panel: is a code required? Answered
 * without a session (the panel asks before anyone can sign in), carries no
 * account data and never the setup code itself — only whether one is
 * required. A broken check must not block the UI, so it answers with the
 * stricter policy on failure. */
export const handleInviteStatus: RouteHandler = async () => {
  try {
    await ensureDb();
  } catch (error) {
    return routeFailure("[auth]", error);
  }

  try {
    const policy = await signupPolicy();

    if (policy.setupMode === "code") {
      // Lazy issue: the first viewer of a fresh public install mints the
      // pending code (logged loudly by the control fleet). Idempotent —
      // later viewers find the pending row and mint nothing.
      await ensureSetupCode();

      return Response.json(await signupPolicy());
    }

    return Response.json(policy);
  } catch {
    return Response.json({
      adminExists: true,
      firstRun: false,
      invitesPerUser: INVITES_PER_USER,
      requiresInvite: true,
      setupMode: "off",
    });
  }
};

export const handleAuth: RouteHandler = async (request, env) => {
  try {
    await ensureDb();

    const auth = authFromEnv(env, new URL(request.url).origin);

    return await auth.handler(withTrustedClientAddress(request));
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }

    // better-auth rethrows a non-API failure (`onAPIError.throw`) so the
    // router's own raw `console.error` never runs: log the cause chain here
    // and answer a generic 500. Normal API errors never reach this branch —
    // better-call still turns them into their response.
    return routeFailure("[auth]", error);
  }
};
