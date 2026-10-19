import * as Schema from "effect/Schema";

import type { EnvVarView } from "../api-types";
import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import { runnerDeleteEnv, runnerListEnv, runnerSetEnv } from "../runner";
import { apiAction } from "./api";
import { requireViewApp, sessionUser } from "./session.server";

const AppId = Schema.String;

const SetEnvArgs = Schema.Struct({
  appId: Schema.String,
  name: Schema.String,
  value: Schema.String,
});
const DeleteEnvArgs = Schema.Struct({
  appId: Schema.String,
  name: Schema.String,
});

const FLAG_VALUES = new Set(["0", "1"]);

/** Redact one runner env row for the browser (see {@link EnvVarView}). */
export const redactEnv = ({
  name,
  updatedAt,
  value,
}: {
  name: string;
  updatedAt: string;
  value: string;
}): EnvVarView => ({
  name,
  updatedAt,
  value: name.startsWith("FLAG_") && FLAG_VALUES.has(value) ? value : "",
});

export const listEnv = apiAction(
  AppId,
  async (appId, { env, request }): Promise<EnvVarView[]> => {
    await requireViewApp(request, env, appId);
    const rows = await runnerListEnv(appId);
    return rows.map((row) => redactEnv(row));
  }
);

export const setEnv = apiAction(
  SetEnvArgs,
  async ({ appId, name, value }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerSetEnv(appId, name, value);
    } catch (error) {
      failUnknown(error);
    }
  }
);

export const deleteEnv = apiAction(
  DeleteEnvArgs,
  async ({ appId, name }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerDeleteEnv(appId, name);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Render stored env as `.dev.vars` text for local dev (admin-gated: this is
 * the one place secret values leave the runner). Values are shell-escaped. */
export const envDotVars = apiAction(AppId, async (appId, { env, request }) => {
  const user = await sessionUser(request, env);
  await requireAppRole(appId, user.id, "admin");
  const rows = await runnerListEnv(appId);
  const lines = rows.map(({ name, value }) => {
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return /\s|#/u.test(value) ? `${name}="${escaped}"` : `${name}=${escaped}`;
  });
  return lines.join("\n");
});
