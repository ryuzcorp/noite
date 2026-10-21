import * as Schema from "effect/Schema";

import { failUnknown } from "../auth";
import { requireAppRole } from "../collaborators";
import { isControlApp } from "../control-app";
import {
  runnerGetError,
  runnerGetIngestKey,
  runnerRotateIngestKey,
  runnerSetErrorStatus,
} from "../runner";
import { apiAction } from "./api";
import { requireControlAdmin, sessionUser } from "./session.server";

const ErrorStatusSchema = Schema.Union([
  Schema.Literal("open"),
  Schema.Literal("resolved"),
  Schema.Literal("ignored"),
]);

const ErrorArgs = Schema.Struct({
  appId: Schema.String,
  fingerprint: Schema.String,
});

const ErrorStatusArgs = Schema.Struct({
  appId: Schema.String,
  fingerprint: Schema.String,
  status: ErrorStatusSchema,
});

/** Gate for one app's observability surfaces (read and triage alike). The
 * reserved control app has no runner row and therefore no collaborator role,
 * so it is gated on the same real-admin / never-impersonating rule as the
 * control D1; every other app keeps its collaborator role. One function, so
 * the two paths cannot drift. */
const requireTelemetryRole = async (
  request: Request,
  env: KitEnv,
  appId: string,
  need: "view" | "push"
): Promise<void> => {
  if (isControlApp(appId)) {
    await requireControlAdmin(request, env);

    return;
  }

  const user = await sessionUser(request, env);
  await requireAppRole(appId, user.id, need);
};

/** One error with its recent occurrences (stack, request, trace logs). */
export const errorDetail = apiAction(
  ErrorArgs,
  async ({ appId, fingerprint }, { env, request }) => {
    await requireTelemetryRole(request, env, appId, "view");

    try {
      return await runnerGetError(appId, fingerprint);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Resolve, ignore or reopen an error — anyone who can push can triage. */
export const setErrorStatus = apiAction(
  ErrorStatusArgs,
  async ({ appId, fingerprint, status }, { env, request }) => {
    await requireTelemetryRole(request, env, appId, "push");

    try {
      return await runnerSetErrorStatus(appId, fingerprint, status);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Resolve the caller role to pass the runner, mirroring requireTelemetryRole:
 * the reserved control app has no collaborator row, so a control admin calls
 * with `"admin"` (which satisfies every `role_ok` need); every other app
 * passes its collaborator role through. */
const ingestRole = async (
  request: Request,
  env: KitEnv,
  appId: string,
  need: "view" | "admin"
): Promise<string> => {
  if (isControlApp(appId)) {
    await requireControlAdmin(request, env);

    return "admin";
  }

  const user = await sessionUser(request, env);
  const { role } = await requireAppRole(appId, user.id, need);

  return role;
};

/** This app's public error-ingest identity (project id + key) for the DSN.
 * View-gated: the key is public by design, it only submits errors. */
export const ingestKey = apiAction(
  Schema.String,
  async (appId, { env, request }) => {
    const role = await ingestRole(request, env, appId, "view");

    try {
      return await runnerGetIngestKey(appId, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);

/** Mint a replacement ingest key, keeping the numeric project id. Admin. */
export const rotateIngestKey = apiAction(
  Schema.String,
  async (appId, { env, request }) => {
    const role = await ingestRole(request, env, appId, "admin");

    try {
      return await runnerRotateIngestKey(appId, role);
    } catch (error) {
      failUnknown(error);
    }
  }
);
