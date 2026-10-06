/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import { action, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import { withDb } from "../db";
import { runnerTelemetryGet, runnerTelemetrySet } from "../runner";
import { AuthError, requireControlAdmin } from "./session.server";

/** Accounts on this instance, for the runner's bucketed `users` heartbeat
 * property. Served to the runner by `GET /internal/telemetry-facts`. */
export const countControlUsers = (): Promise<number> =>
  withDb(
    Effect.gen(function* countUsers() {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM "user"`;
      return Number(rows[0]?.n ?? 0);
    })
  );

/** The telemetry opt-out state behind the `/account` admin section. A real
 * instance admin only, never an impersonated session: the runner takes any
 * bearer call, so the gate has to live here. */
export const getTelemetry = action(
  async () => {
    await requireControlAdmin();
    try {
      return await runnerTelemetryGet();
    } catch (error) {
      return failUnknown(error);
    }
  },
  { error: AuthError }
);

const SetTelemetry = Schema.Struct({ enabled: Schema.Boolean });

/** Store the preference; the runner keeps it even while the setting is locked
 * (effective stays disabled). Same admin gate as the read. */
export const setTelemetry = action(
  withSchema(SetTelemetry, async ({ enabled }) => {
    await requireControlAdmin();
    try {
      return await runnerTelemetrySet(enabled);
    } catch (error) {
      return failUnknown(error);
    }
  }),
  { error: AuthError }
);
