import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import { runnerGetLogs } from "../runner";
import { apiAction } from "./api";
import { requireTelemetryRole } from "./errors.server";

const LogTailArgs = Schema.Struct({
  appId: Schema.String,
  environmentId: Schema.optional(Schema.String),
});

/** Merged log tail (ingested ring plus the fleet's live stdout), oldest
 * first: the initial snapshot behind the live Logs tail, so it renders
 * current lines even when the stream's first frame is delayed or lost.
 * View-gated like the stream. */
export const logTail = apiAction(
  LogTailArgs,
  async ({ appId, environmentId }, { env, request }) => {
    await requireTelemetryRole(request, env, appId, "view");

    try {
      return await runnerGetLogs(appId, environmentId ?? "");
    } catch (error) {
      failUnknown(error);
    }
  }
);
