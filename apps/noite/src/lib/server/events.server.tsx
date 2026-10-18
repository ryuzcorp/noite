/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Schema from "effect/Schema";

import { runnerGetUserProps } from "../runner";
import { action, useEnv, useRequest, withSchema } from "../server-context";
import { AuthError, requireViewApp } from "./session.server";

const UserPropsArgs = Schema.Struct({
  appId: Schema.String,
  userId: Schema.String,
});

export const getUserProps = action(
  withSchema(UserPropsArgs, async ({ appId, userId }) => {
    await requireViewApp(useRequest(), useEnv<KitEnv>(), appId);
    return runnerGetUserProps(appId, userId);
  }),
  { error: AuthError }
);
