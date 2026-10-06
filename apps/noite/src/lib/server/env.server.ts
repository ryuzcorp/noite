import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import { runnerDeleteEnv, runnerListEnv, runnerSetEnv } from "../runner";
import { AuthError, requireViewApp, sessionUser } from "./session.server";

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

/** One env row as the browser sees it. Values are write-only: only
 * `FLAG_*` toggles (non-secret `1`/`0` by convention) carry theirs, so a
 * view-only collaborator — or anything persisted client-side — never holds a
 * secret. */
export interface EnvVarView {
  name: string;
  updatedAt: string;
  value: string;
}

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

export const listEnv = action(
  withSchema(AppId, async (appId): Promise<EnvVarView[]> => {
    await requireViewApp(appId);
    const rows = await runnerListEnv(appId);
    return rows.map((row) => redactEnv(row));
  }),
  { error: AuthError }
);

export const setEnv = action(
  withSchema(SetEnvArgs, async ({ appId, name, value }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerSetEnv(appId, name, value);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const deleteEnv = action(
  withSchema(DeleteEnvArgs, async ({ appId, name }) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    try {
      return await runnerDeleteEnv(appId, name);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Render stored env as `.dev.vars` text for local dev (admin-gated: this is
 * the one place secret values leave the runner). Values are shell-escaped. */
export const envDotVars = action(
  withSchema(AppId, async (appId) => {
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "admin");
    const rows = await runnerListEnv(appId);
    const lines = rows.map(({ name, value }) => {
      const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      return /\s|#/u.test(value)
        ? `${name}="${escaped}"`
        : `${name}=${escaped}`;
    });
    return lines.join("\n");
  }),
  { error: AuthError }
);
