/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import { sessionUser } from "./apps.server";
import { MissingAuthSecretError, UnauthorizedError } from "./auth";
import { requireAppRole } from "./collaborators";
import { runnerGetUserProps } from "./runner";

const AuthError = Schema.Union([UnauthorizedError, MissingAuthSecretError]);

const UserPropsArgs = Schema.Struct({
  appId: Schema.String,
  userId: Schema.String,
});

/** Ownership gate for event reads — the runner is the data source. */
const requireViewApp = async (appId: string): Promise<void> => {
  const user = await sessionUser();
  await requireAppRole(appId, user.id, "view");
};

export const getUserProps = action(
  withSchema(UserPropsArgs, async ({ appId, userId }) => {
    await requireViewApp(appId);
    return runnerGetUserProps(appId, userId);
  }),
  { error: AuthError }
);
