import { authFromEnv, MissingAuthSecretError } from "../../lib/auth";
import { ensureDb } from "../../lib/db";
import { withTrustedClientAddress } from "../../lib/rate-limit";
import {
  INVITES_PER_USER,
  signupPolicy,
} from "../../lib/server/invites.server";
import type { RouteHandler } from "../config";

/** Public signup policy for the login panel: is a code required? Answered
 * without a session (the panel asks before anyone can sign in), carries no
 * account data. A broken check must not block the UI, so it answers with the
 * stricter policy on failure. */
export const handleInviteStatus: RouteHandler = async () => {
  await ensureDb();

  try {
    return Response.json(await signupPolicy());
  } catch {
    return Response.json({
      firstRun: false,
      invitesPerUser: INVITES_PER_USER,
      requiresInvite: true,
    });
  }
};

export const handleAuth: RouteHandler = async (request, env) => {
  await ensureDb();

  try {
    const auth = authFromEnv(env, new URL(request.url).origin);

    return await auth.handler(withTrustedClientAddress(request));
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }

    throw error;
  }
};
