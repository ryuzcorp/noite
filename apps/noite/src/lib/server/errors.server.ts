import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import { isControlApp } from "../control-app";
import { runnerGetError, runnerSetErrorStatus } from "../runner";
import { AuthError, requireControlAdmin, sessionUser } from "./session.server";

const ErrorStatusSchema = Schema.Union([
  Schema.Literal("open"),
  Schema.Literal("resolved"),
  Schema.Literal("ignored"),
]);
const ErrorArgs = Schema.Struct({
  appId: Schema.String,
  fingerprint: Schema.String,
});
const ErrorStatusArgs = Schema.Struct({
  appId: Schema.String,
  fingerprint: Schema.String,
  status: ErrorStatusSchema,
});

/** Gate for one app's observability surfaces (read and triage alike). The
 * reserved control app has no runner row and therefore no collaborator role,
 * so it is gated on the same real-admin / never-impersonating rule as the
 * control D1; every other app keeps its collaborator role. One function, so
 * the two paths cannot drift. */
const requireTelemetryRole = async (
  appId: string,
  need: "view" | "push"
): Promise<void> => {
  if (isControlApp(appId)) {
    await requireControlAdmin();
    return;
  }
  const user = await sessionUser();
  await requireAppRole(appId, user.id, need);
};

/** One error with its recent occurrences (stack, request, trace logs). */
export const errorDetail = action(
  withSchema(ErrorArgs, async ({ appId, fingerprint }) => {
    await requireTelemetryRole(appId, "view");
    try {
      return await runnerGetError(appId, fingerprint);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Resolve, ignore or reopen an error — anyone who can push can triage. */
export const setErrorStatus = action(
  withSchema(ErrorStatusArgs, async ({ appId, fingerprint, status }) => {
    await requireTelemetryRole(appId, "push");
    try {
      return await runnerSetErrorStatus(appId, fingerprint, status);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
