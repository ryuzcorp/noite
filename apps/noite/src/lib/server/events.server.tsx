/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Schema from "effect/Schema";

import { runnerGetUserProps } from "../runner";
import { apiAction } from "./api";
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
