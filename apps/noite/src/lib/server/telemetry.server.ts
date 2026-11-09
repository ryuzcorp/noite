import * as Schema from "effect/Schema";
import { sql } from "void/db";

import { failUnknown } from "../auth";
import { getDb, withDb } from "../db";
import { runnerTelemetryGet, runnerTelemetrySet } from "../runner";
import { apiAction, apiActionNoInput } from "./api";
import { requireControlAdmin } from "./session.server";

/** Accounts on this instance, for the runner's bucketed `users` heartbeat
 * property. Served to the runner by `GET /internal/telemetry-facts`. */
export const countControlUsers = (): Promise<number> =>
  withDb(async () => {
    const row = await getDb().get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM "user"`
    );

    return Number(row?.n ?? 0);
  });

/** The telemetry opt-out state behind the `/account` admin section. A real
 * instance admin only, never an impersonated session: the runner takes any
 * bearer call, so the gate has to live here. */
export const getTelemetry = apiActionNoInput(async ({ env, request }) => {
  await requireControlAdmin(request, env);

  try {
    return await runnerTelemetryGet();
  } catch (error) {
    return failUnknown(error);
  }
});

const SetTelemetry = Schema.Struct({ enabled: Schema.Boolean });

/** Store the preference; the runner keeps it even while the setting is locked
 * (effective stays disabled). Same admin gate as the read. */
export const setTelemetry = apiAction(
  SetTelemetry,
  async ({ enabled }, { env, request }) => {
    await requireControlAdmin(request, env);

    try {
      return await runnerTelemetrySet(enabled);
    } catch (error) {
      return failUnknown(error);
    }
  }
);
