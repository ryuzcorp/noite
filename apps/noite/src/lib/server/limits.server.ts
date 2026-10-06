import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import { runnerGetLimits, runnerSetLimits } from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

const AppId = Schema.String;

const Rpm = Schema.Union([Schema.Number, Schema.Null]);
const LimitArgs = Schema.Struct({
  appId: Schema.String,
  appRpm: Rpm,
  clientRpm: Rpm,
});

/** The app's edge limits beside the platform defaults they fall back to. */
export const getLimits = action(
  withSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    try {
      return await runnerGetLimits(appId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Set the app's edge limits (admin). The runner owns the range check and
 * rewrites the edge on its next reconcile. */
export const setLimits = action(
  withSchema(LimitArgs, async ({ appId, appRpm, clientRpm }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerSetLimits(appId, clientRpm, appRpm);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
