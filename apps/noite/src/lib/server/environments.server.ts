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
import { apiAction } from "./api";
import { redactEnv } from "./env.server";
import { sessionUser } from "./session.server";

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

/** Every environment of one app (view-gated). */
export const listEnvironments = apiAction(
  AppId,
  async (appId, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "view");
    try {
      return await runnerEnvironmentsList(appId, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Create the environment for `branch` and deploy its head (push-gated). The
 * label is derived by the runner from the branch. */
export const createEnvironment = apiAction(
  BranchArgs,
  async ({ appId, branch }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      return await runnerEnvironmentCreate(appId, branch, role, {
        name: user.name,
        userId: user.id,
      });
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Delete one environment and its fleet (admin-gated). */
export const deleteEnvironment = apiAction(
  EnvId,
  async ({ appId, envId }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "admin");
    try {
      await runnerEnvironmentDelete(appId, envId, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Flip one environment between members-only and public (admin-gated). */
export const updateEnvironment = apiAction(
  PublicArgs,
  async ({ appId, envId, public: isPublic }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerEnvironmentUpdate(appId, envId, isPublic, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Redeploy one environment at its ref's current tip (push-gated). */
export const deployEnvironment = apiAction(
  EnvId,
  async ({ appId, envId }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      return await runnerEnvironmentDeploy(appId, envId, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** One environment's variable overrides, redacted for the browser
 * (view-gated). */
export const environmentVars = apiAction(
  EnvId,
  async ({ appId, envId }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "view");
    try {
      const rows = await runnerEnvironmentVars(appId, envId, role);
      return rows.map((row) => redactEnv(row));
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Set one variable override on an environment (push-gated). */
export const setEnvironmentVar = apiAction(
  VarArgs,
  async ({ appId, envId, name, value }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      return await runnerEnvironmentVarSet(appId, envId, name, value, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Delete one variable override (push-gated). */
export const deleteEnvironmentVar = apiAction(
  VarNameArgs,
  async ({ appId, envId, name }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "push");
    try {
      await runnerEnvironmentVarDelete(appId, envId, name, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);
