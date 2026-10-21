import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import {
  runnerAddDomain,
  runnerListDomains,
  runnerRemoveDomain,
  runnerVerifyDomain,
} from "../runner";
import { apiAction } from "./api";
import { sessionUser } from "./session.server";

const AppId = Schema.String;

const DomainArgs = Schema.Struct({
  appId: Schema.String,
  hostname: Schema.String,
});

/** Hostnames this app answers on. The runner enforces the view gate, so the
 * resolved role is passed through (mirrors `environments.list`). */
export const listDomains = apiAction(AppId, async (appId, { env, request }) => {
  const user = await sessionUser(request, env);
  const { role } = await requireAppRole(appId, user.id, "view");

  try {
    return await runnerListDomains(appId, role);
  } catch (error) {
    failUnknown(error);
  }
});

/** Reserve a hostname for the app (admin). In `multi` tenancy the claim
 * starts pending and the panel shows the TXT proof to publish; in `single`
 * it is verified at once. The runner is the authority on shape, collisions,
 * platform-owned names and the role gate; its message is surfaced. */
export const addDomain = apiAction(
  DomainArgs,
  async ({ appId, hostname }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "admin");

    try {
      return await runnerAddDomain(appId, hostname, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Check this app's pending claim against its TXT proof (admin). The
 * runner's failure reason names what was missing (no record, wrong value,
 * DNS error, or a lost race); it is surfaced so the panel can show it. */
export const verifyDomain = apiAction(
  DomainArgs,
  async ({ appId, hostname }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "admin");

    try {
      return await runnerVerifyDomain(appId, hostname, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

export const removeDomain = apiAction(
  DomainArgs,
  async ({ appId, hostname }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "admin");

    try {
      return await runnerRemoveDomain(appId, hostname, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);
