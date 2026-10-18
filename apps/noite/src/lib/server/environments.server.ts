//! Preview environments: the control UI's actions over the runner's
//! `environments.*` RPCs (list/create/delete/update/deploy + variable
//! overrides).
//!
//! The runner enforces the app role on every call, so each action resolves the
//! caller's role here (`view` to read, `push` to create/deploy and set
//! variables, `admin` to delete and to flip an environment public) and passes
//! the resolved role through: a missing role is a runner-side refusal, never a
//! default.

import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import {
  runnerEnvironmentCreate,
  runnerEnvironmentDelete,
  runnerEnvironmentDeploy,
  runnerEnvironmentUpdate,
  runnerEnvironmentVarDelete,
  runnerEnvironmentVars,
  runnerEnvironmentVarSet,
  runnerEnvironmentsList,
} from "../runner";
import { action, useEnv, useRequest, withSchema } from "../server-context";
import { redactEnv } from "./env.server";
import type { EnvVarView } from "./env.server";
import { AuthError, sessionUser } from "./session.server";

const AppId = Schema.String;
const BranchArgs = Schema.Struct({
  appId: Schema.String,
  branch: Schema.String,
});
const EnvId = Schema.Struct({ appId: Schema.String, envId: Schema.String });
const PublicArgs = Schema.Struct({
  appId: Schema.String,
  envId: Schema.String,
  public: Schema.Boolean,
});
const VarArgs = Schema.Struct({
  appId: Schema.String,
  envId: Schema.String,
  name: Schema.String,
  value: Schema.String,
});
const VarNameArgs = Schema.Struct({
  appId: Schema.String,
  envId: Schema.String,
  name: Schema.String,
});

/** One environment variable override as the browser sees it: values are
 * write-only except the non-secret `FLAG_*` toggles (see `redactEnv`). */
export type EnvironmentVarView = EnvVarView;

/** Every environment of one app (view-gated). */
export const listEnvironments = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "view");
    try {
      return await runnerEnvironmentsList(appId, role);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Create the environment for `branch` and deploy its head (push-gated). The
 * label is derived by the runner from the branch. */
export const createEnvironment = action(
  withSchema(BranchArgs, async ({ appId, branch }) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      return await runnerEnvironmentCreate(appId, branch, role, {
        name: user.name,
        userId: user.id,
      });
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Delete one environment and its fleet (admin-gated). */
export const deleteEnvironment = action(
  withSchema(EnvId, async ({ appId, envId }) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "admin");
    try {
      await runnerEnvironmentDelete(appId, envId, role);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Flip one environment between members-only and public (admin-gated). */
export const updateEnvironment = action(
  withSchema(PublicArgs, async ({ appId, envId, public: isPublic }) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerEnvironmentUpdate(appId, envId, isPublic, role);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Redeploy one environment at its ref's current tip (push-gated). */
export const deployEnvironment = action(
  withSchema(EnvId, async ({ appId, envId }) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      return await runnerEnvironmentDeploy(appId, envId, role);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** One environment's variable overrides, redacted for the browser
 * (view-gated). */
export const environmentVars = action(
  withSchema(EnvId, async ({ appId, envId }) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "view");
    try {
      const rows = await runnerEnvironmentVars(appId, envId, role);
      return rows.map((row) => redactEnv(row));
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Set one variable override on an environment (push-gated). */
export const setEnvironmentVar = action(
  withSchema(VarArgs, async ({ appId, envId, name, value }) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      return await runnerEnvironmentVarSet(appId, envId, name, value, role);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Delete one variable override (push-gated). */
export const deleteEnvironmentVar = action(
  withSchema(VarNameArgs, async ({ appId, envId, name }) => {
    const user = await sessionUser(useRequest(), useEnv<KitEnv>());
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      await runnerEnvironmentVarDelete(appId, envId, name, role);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
