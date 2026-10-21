import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import { runnerUpdateGet, runnerUpdateSet } from "../runner";
import { apiAction, apiActionNoInput } from "./api";
import { requireControlAdmin } from "./session.server";

/** The opt-out update-check state behind the `/account` admin section. A real
 * instance admin only, never an impersonated session: the runner takes any
 * bearer call, so the gate has to live here. */
export const getUpdateStatus = apiActionNoInput(async ({ env, request }) => {
  await requireControlAdmin(request, env);

  try {
    return await runnerUpdateGet();
  } catch (error) {
    return failUnknown(error);
  }
});

const SetUpdateStatus = Schema.Struct({ enabled: Schema.Boolean });

/** Store the preference; enabling runs one immediate check runner-side (a
 * failed fetch keeps the last result). Same admin gate as the read. */
export const setUpdateStatus = apiAction(
  SetUpdateStatus,
  async ({ enabled }, { env, request }) => {
    await requireControlAdmin(request, env);

    try {
      return await runnerUpdateSet(enabled);
    } catch (error) {
      return failUnknown(error);
    }
  }
);
