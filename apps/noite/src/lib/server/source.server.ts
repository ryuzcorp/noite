import * as Schema from "effect/Schema";
import { action, withSchema } from "oxidejs";

import { runnerSourceBundle, runnerSourceTree } from "../runner";
import { AuthError, requireViewApp } from "./session.server";

/** Every source read takes an optional `ref` (branch, tag or SHA); Code mode
 * always sends one. Absent or `""` keeps the runner's deployed-SHA-then-HEAD
 * resolution; the runner refuses an empty ref, so `""` never reaches it. */
const SourceRefArgs = Schema.Struct({
  appId: Schema.String,
  ref: Schema.optional(Schema.String),
});

export const sourceTree = action(
  withSchema(SourceRefArgs, async ({ appId, ref }) => {
    await requireViewApp(appId);
    return runnerSourceTree(appId, ref || undefined);
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
