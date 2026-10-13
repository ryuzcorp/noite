/** Browser commit client + the shared limits for the control route that
 * carries it. Commits go through `POST /api/apps/{id}/source/commit` (not an
 * oxide action) because an action body is capped for every action, and an
 * action reads its body before any auth — a browser commit can be a folder of
 * uploads (see `apps/runner/src/host/web_commit.rs`). */

import type { SourceCommitFile, SourceCommitMove } from "./runner";

/** Largest commit body the route reads. Must match `MAX_COMMIT_BODY_BYTES` in
 * `apps/runner/src/host/web_commit.rs`: the runner caps a commit at 25 MiB
 * decoded, which base64 inflates by 4/3. */
export const MAX_COMMIT_BODY_BYTES = 40 * 1024 * 1024;

/** How long the route waits on the runner for a commit before failing. */
export const COMMIT_FORWARD_TIMEOUT_MS = 12_000;

/** What `commitSource` takes; optional fields are omitted, never `undefined`. */
export interface SourceCommitInput {
  appId: string;
  branch?: string;
  deletes?: readonly string[];
  files: readonly SourceCommitFile[];
  fromSha?: string;
  message: string;
  moves?: readonly SourceCommitMove[];
}

/** Commit browser drafts: session + push gate happen on the route before the
 * body is read, then the runner makes the commit and answers `{ sha }`. */
export const commitSource = async (
  input: SourceCommitInput
): Promise<{ sha: string }> => {
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
  // SAFETY: the route re-serves the runner's `{ sha }` JSON verbatim.
  return (await res.json()) as { sha: string };
};
