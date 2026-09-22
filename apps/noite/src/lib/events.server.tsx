/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Schema from "effect/Schema";
import { action } from "oxidejs";

import { checkedSchema } from "./action-schema";
import { sessionUser } from "./apps.server";
import { ActionError, MissingAuthSecretError, UnauthorizedError } from "./auth";
import { requireAppRole } from "./collaborators";
import {
  runnerGetUserProps,
  runnerListEventChannels,
  runnerListEvents,
  runnerListInsights,
} from "./runner";

const AppId = Schema.String;
const AuthError = Schema.Union([
  UnauthorizedError,
  MissingAuthSecretError,
  ActionError,
]);

const ListEventsArgs = Schema.Struct({
  appId: Schema.String,
  channel: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});

const UserPropsArgs = Schema.Struct({
  appId: Schema.String,
  userId: Schema.String,
});

/** Ownership gate for event reads — the runner is the data source. */
const requireViewApp = async (appId: string): Promise<void> => {
  const user = await sessionUser();
  await requireAppRole(appId, user.id, "view");
};

export const listEvents = action(
  checkedSchema(ListEventsArgs, async ({ appId, channel, limit }) => {
    await requireViewApp(appId);
    return runnerListEvents(appId, channel, limit ?? 50);
  }),
  { error: AuthError }
);

export const listEventChannels = action(
  checkedSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    return runnerListEventChannels(appId);
  }),
  { error: AuthError }
);

export const listInsights = action(
  checkedSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    return runnerListInsights(appId);
  }),
  { error: AuthError }
);

export const getUserProps = action(
  checkedSchema(UserPropsArgs, async ({ appId, userId }) => {
    await requireViewApp(appId);
    return runnerGetUserProps(appId, userId);
  }),
  { error: AuthError }
);
