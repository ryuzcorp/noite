import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import {
  runnerAddDomain,
  runnerListDomains,
  runnerRemoveDomain,
} from "../runner";
import { apiAction } from "./api";
import { requireViewApp, sessionUser } from "./session.server";

const AppId = Schema.String;

const DomainArgs = Schema.Struct({
  appId: Schema.String,
  hostname: Schema.String,
});

/** Hostnames this app answers on, for anyone who can see the app. */
export const listDomains = apiAction(AppId, async (appId, { env, request }) => {
  await requireViewApp(request, env, appId);
  try {
    return await runnerListDomains(appId);
  } catch (error) {
    failUnknown(error);
  }
});

/** Reserve a hostname for the app (admin). The runner is the authority on
 * shape, collisions and platform-owned names; its message is surfaced. */
export const addDomain = apiAction(
  DomainArgs,
  async ({ appId, hostname }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerAddDomain(appId, hostname);
    } catch (error) {
      failUnknown(error);
    }
  }
);

export const removeDomain = apiAction(
  DomainArgs,
  async ({ appId, hostname }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerRemoveDomain(appId, hostname);
    } catch (error) {
      failUnknown(error);
    }
  }
);
