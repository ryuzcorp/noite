import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import { runnerGetLimits, runnerSetLimits } from "../runner";
import { apiAction } from "./api";
import { requireViewApp, sessionUser } from "./session.server";

const AppId = Schema.String;

const Rpm = Schema.Union([Schema.Number, Schema.Null]);
const LimitArgs = Schema.Struct({
  appId: Schema.String,
  appRpm: Rpm,
  clientRpm: Rpm,
});

/** The app's edge limits beside the platform defaults they fall back to. */
export const getLimits = apiAction(AppId, async (appId, { env, request }) => {
  await requireViewApp(request, env, appId);
  try {
    return await runnerGetLimits(appId);
  } catch (error) {
    failUnknown(error);
  }
});

/** Set the app's edge limits (admin). The runner owns the range check and
 * rewrites the edge on its next reconcile. */
export const setLimits = apiAction(
  LimitArgs,
  async ({ appId, appRpm, clientRpm }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerSetLimits(appId, clientRpm, appRpm);
    } catch (error) {
      failUnknown(error);
    }
  }
);
