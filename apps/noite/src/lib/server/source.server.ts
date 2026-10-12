import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import {
  runnerSourceBlob,
  runnerSourceBundle,
  runnerSourceTree,
  runnerSourceTypes,
} from "../runner";
import { AuthError, requireViewApp } from "./session.server";

/** Every source read takes an optional `ref` (branch, tag or SHA); Code mode
 * always sends one. Absent or `""` keeps the runner's deployed-SHA-then-HEAD
 * resolution; the runner refuses an empty ref, so `""` never reaches it. */
const SourceRefArgs = Schema.Struct({
  appId: Schema.String,
  ref: Schema.optional(Schema.String),
});

/** Source preview — the runner serves from the persistent bare mirror. */
const SourceBlobArgs = Schema.Struct({
  appId: Schema.String,
  path: Schema.String,
  ref: Schema.optional(Schema.String),
});
export const sourceTree = action(
  withSchema(SourceRefArgs, async ({ appId, ref }) => {
    await requireViewApp(appId);
    return runnerSourceTree(appId, ref || undefined);
  }),
  { error: AuthError }
);

export const sourceBlob = action(
  withSchema(SourceBlobArgs, async ({ appId, path, ref }) => {
    await requireViewApp(appId);
    return runnerSourceBlob(appId, path, ref || undefined);
  }),
  { error: AuthError }
);

/** Every text source in the repo at `ref`, for the language-service worker's
 * virtual FS (one round trip instead of one blob per file). Same ref rules as
 * `sourceTree`. */
export const sourceBundle = action(
  withSchema(SourceRefArgs, async ({ appId, ref }) => {
    await requireViewApp(appId);
    return runnerSourceBundle(appId, ref || undefined);
  }),
  { error: AuthError }
);

/** Declaration files captured from the app's last successful build — the
 * `node_modules` types the worker resolves imports against. No `ref`: the
 * capture belongs to the deployed build, whatever is being browsed. */
const SourceTypesArgs = Schema.Struct({ appId: Schema.String });
export const sourceTypes = action(
  withSchema(SourceTypesArgs, async ({ appId }) => {
    await requireViewApp(appId);
    return runnerSourceTypes(appId);
  }),
  { error: AuthError }
);
