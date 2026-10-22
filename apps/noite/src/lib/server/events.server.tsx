/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import {
  runnerGetUserProps,
  runnerListEventChannels,
  runnerListEventInsights,
  runnerListEvents,
} from "../runner";
import { apiAction } from "./api";
import { requireTelemetryRole } from "./errors.server";
import { requireViewApp } from "./session.server";

const UserPropsArgs = Schema.Struct({
  appId: Schema.String,
  environmentId: Schema.optional(Schema.String),
  userId: Schema.String,
});

export const getUserProps = apiAction(
  UserPropsArgs,
  async ({ appId, environmentId, userId }, { env, request }) => {
    await requireViewApp(request, env, appId);

    return runnerGetUserProps(appId, userId, environmentId ?? "");
  }
);

const EventsSnapshotArgs = Schema.Struct({
  appId: Schema.String,
  channel: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});

/** The combined snapshot behind the live Events feed (`feed` rows plus the
 * `channels` and `insights` widgets, like the stream frame): the initial
 * snapshot, so the feed renders current data even when the stream's first
 * frame is delayed or lost. View-gated like the stream. */
export const eventsSnapshot = apiAction(
  EventsSnapshotArgs,
  async ({ appId, channel, environmentId, limit }, { env, request }) => {
    await requireTelemetryRole(request, env, appId, "view");

    const scope = environmentId ?? "";

    try {
      const [channels, feed, insights] = await Promise.all([
        runnerListEventChannels(appId, scope),
        runnerListEvents(appId, channel ?? "", limit ?? 200, scope),
        runnerListEventInsights(appId, scope),
      ]);

      return { channels, feed, insights };
    } catch (error) {
      failUnknown(error);
    }
  }
);
