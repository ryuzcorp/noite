/** Browser commit client + the shared limits for the control route that
 * carries it. It goes through `POST /api/apps/{id}/source/commit` (not a Void
 * JSON action) because an action body is capped (256 KiB, `MAX_BODY_BYTES`),
 * and the transport reads it before any auth — a browser commit can be a
 * folder of uploads (see `apps/runner/src/host/web_commit.rs`). */

import type { SourceCommitFile, SourceCommitMove } from "./runner";

/** Largest source body the route reads. Must match `MAX_COMMIT_BODY_BYTES` in
 * `apps/runner/src/host/web_commit.rs`: the runner caps a commit at 25 MiB
 * decoded, which base64 inflates by 4/3. */
export const MAX_SOURCE_BODY_BYTES = 40 * 1024 * 1024;

/** How long the routes wait on the runner for the write before failing. */
export const SOURCE_FORWARD_TIMEOUT_MS = 12_000;

/** What `commitSource` takes; optional fields are omitted, never
 * `undefined`. */
export interface SourceCommitInput {
  appId: string;
  branch?: string;
  deletes?: readonly string[];
  files: readonly SourceCommitFile[];
  /** The commit a `branch` this push creates starts from: the tip of the
   * branch being browsed. Unused when `branch` already exists — the runner
   * grows an existing branch from its own tip. */
  fromSha?: string;
  message: string;
  moves?: readonly SourceCommitMove[];
}

/** POST one web-commit body to `/api/apps/{id}/source/commit` and read the
 * runner's answer back. */
const postSourceBody = async <T>(input: SourceCommitInput): Promise<T> => {
  const { appId, ...body } = input;

  const res = await fetch(
    `/api/apps/${encodeURIComponent(appId)}/source/commit`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`commit failed: ${res.status} ${text}`);
  }

  // SAFETY: the route re-serves the runner's own JSON verbatim (`{ sha }`).
  return (await res.json()) as T;
};

/** Commit browser drafts: session + push gate happen on the route before the
 * body is read, then the runner makes the commit and answers `{ sha }`. */
export const commitSource = (input: SourceCommitInput) =>
  postSourceBody<{ sha: string }>(input);
