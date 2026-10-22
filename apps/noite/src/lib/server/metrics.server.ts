import * as Schema from "effect/Schema";

import { runnerConfig } from "../../http/config";
import {
  pollMetricsFrame,
  pollMetricsVersion,
} from "../../http/routes/streams";
import { failUnknown } from "../auth";
import { apiAction, fail } from "./api";
import { requireTelemetryRole } from "./errors.server";

/** Windows the metrics endpoints serve, in hours (mirrors the stream's
 * `METRICS_WINDOWS_HOURS` in `http/routes/streams.ts`). */
const METRICS_WINDOWS_HOURS = new Set([24, 168, 720]);

const MetricsFrameArgs = Schema.Struct({
  appId: Schema.String,
  environmentId: Schema.optional(Schema.String),
  hours: Schema.Number,
});

/** One usage-stats frame (same shape as the stream frame): the initial
 * snapshot behind the live Metrics card, so it renders current numbers even
 * when the stream's first frame is delayed or lost. Assembled with the same
 * poll the stream runs. View-gated like the stream. */
export const metricsFrame = apiAction(
  MetricsFrameArgs,
  async ({ appId, environmentId, hours }, { env, request }) => {
    await requireTelemetryRole(request, env, appId, "view");

    const rc = runnerConfig(env) ?? fail("RUNNER_TOKEN is not configured");

    const windowHours = METRICS_WINDOWS_HOURS.has(hours) ? hours : 24;
    const scope = environmentId ?? "";
    const base = `${rc.runner}/v1/apps/${encodeURIComponent(appId)}`;
    const auth = { authorization: `Bearer ${rc.token}` };

    const envQuery =
      scope === "" ? "" : `&environmentId=${encodeURIComponent(scope)}`;

    try {
      await pollMetricsVersion(base, auth, envQuery);

      const polled = await pollMetricsFrame(
        {
          auth,
          base,
          envQuery,
          windowQuery: `hours=${windowHours}${envQuery}`,
        },
        -1
      );

      return polled?.frame ?? null;
    } catch (error) {
      failUnknown(error);
    }
  }
);
