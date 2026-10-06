import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import {
  runnerAddDomain,
  runnerListDomains,
  runnerRemoveDomain,
} from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

const AppId = Schema.String;

const DomainArgs = Schema.Struct({
  appId: Schema.String,
  hostname: Schema.String,
});

/** Hostnames this app answers on, for anyone who can see the app. */
export const listDomains = action(
  withSchema(AppId, async (appId) => {
    await requireViewApp(appId);
    try {
      return await runnerListDomains(appId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Reserve a hostname for the app (admin). The runner is the authority on
 * shape, collisions and platform-owned names; its message is surfaced. */
export const addDomain = action(
  withSchema(DomainArgs, async ({ appId, hostname }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerAddDomain(appId, hostname);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const removeDomain = action(
  withSchema(DomainArgs, async ({ appId, hostname }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerRemoveDomain(appId, hostname);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
