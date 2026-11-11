import * as Schema from "effect/Schema";

import { runnerSourceBlob, runnerSourceTree } from "../runner";
import { apiAction } from "./api";
import { requireViewApp } from "./session.server";

/** Every source read takes an optional `ref` (branch, tag or SHA); Code mode
 * always sends one. Absent or `""` keeps the runner's deployed-SHA-then-HEAD
 * resolution; the runner refuses an empty ref, so `""` never reaches it. */
const SourceRefArgs = Schema.Struct({
  appId: Schema.String,
  ref: Schema.optional(Schema.String),
});

export const sourceTree = apiAction(
  SourceRefArgs,
  async ({ appId, ref }, { env, request }) => {
    await requireViewApp(request, env, appId);

    return runnerSourceTree(appId, ref || undefined);
  }
);

/** One file's committed text at `ref` — what the editor opens. The runner
 * caps it (256 KiB) and marks a binary or truncated read, which the pane shows
 * as a placeholder instead of text. */
const SourceBlobArgs = Schema.Struct({
  appId: Schema.String,
  path: Schema.String,
  ref: Schema.optional(Schema.String),
});

export const sourceBlob = apiAction(
  SourceBlobArgs,
  async ({ appId, path, ref }, { env, request }) => {
    await requireViewApp(request, env, appId);

    return runnerSourceBlob(appId, path, ref || undefined);
  }
);
