//! The source browser's push and panel model: what a push is, what the page
//! and the Changes panel read back, and the three row actions they ask the
//! browser for. The changes themselves live in the workspace (`./workspace`);
//! this module holds the shapes that cross the boundary.

import type { PreviewResult } from "../runner";
import type { WorkspaceChange } from "./workspace/types";

/** Why the browsed checkout is read-only: `""` when it is editable, else
 * `tag`/`commit` (a tag or a raw commit sha — the runner can only commit to a
 * branch) or `role` (the viewer's app role is below `push`). */
export type ReadOnlyRef = "" | "tag" | "commit" | "role";

/** Where the last push landed (`newBranch`: the push created `branch`). */
export interface PushedTo {
  branch: string;
  newBranch: boolean;
}

/** What the last Deploy preview snapshotted: the branch it went to, and the
 * fingerprint of the changes it deployed (see `changesFingerprint`). */
export interface PreviewedSnapshot {
  branch: string;
  fingerprint: string;
}

/** Change/push state reported to the page (the Changes panel renders it). */
export interface SourceBrowserState {
  /** The paths another tab changed under this one's feet that this tab also
   * holds unsaved edits to, most recent first, deduped. */
  conflicts: readonly string[];
  /** The workspace's changes, as of the last derive. */
  files: readonly WorkspaceChange[];
  /** What this browser last deployed as a preview, or null when it has not
   * deployed one: the Preview panel compares its fingerprint with the
   * checkout's current one to tell whether the framed snapshot holds every
   * edit. */
  previewed: PreviewedSnapshot | null;
  pushError: string;
  pushed: PushedTo | null;
  pushing: boolean;
  /** Why the installed checkout cannot be edited (see `ReadOnlyRef`). */
  readOnly: ReadOnlyRef;
  /** Bumped on every change: a key for views rebuilt from `files`. */
  revision: number;
  /** The commit the pod is based on, when the browsed tip has moved on since —
   * pushing from it may conflict. */
  stale: string | null;
}

/** A push the Changes panel asks for. `branch` names a new branch to commit
 * to, started at the tip of the branch being browsed; omitted, the commit
 * goes to the browsed branch itself. */
export interface PushRequest {
  branch?: string;
  message: string;
}

/** Commits the changes as `request` asks; resolves whether the push landed. */
export type CommitDrafts = (request: PushRequest) => Promise<boolean>;

/** Snapshots the workspace's uncommitted changes as one commit on the hidden
 * preview ref and deploys that (viewer, branch) environment; resolves what was
 * deployed and where, or null when there is nothing to snapshot or the
 * snapshot failed (the reason lands in `pushError`, like a push's). The pod's
 * own base and changes are untouched: a preview is not a push. */
export type PreviewDrafts = () => Promise<PreviewResult | null>;

/** What the browser hands the page once it is mounted: the commit the Changes
 * form calls, the preview the Preview panel deploys, and the row actions
 * their buttons call (each of which has already asked its own confirmation). */
export interface DraftActions {
  commit: CommitDrafts;
  /** Acknowledge one path another tab changed under this one's feet (see
   * `SourceBrowserState.conflicts`): it leaves the notice, and stays quiet
   * until this checkout is opened again. */
  dismissConflicts: (path: string) => void;
  /** Discard one row's change: an edit goes back to the committed text, an
   * added file (text or upload) leaves the tree, and a moved file keeps its
   * move with the edit dropped. */
  discard: (path: string) => void;
  /** Discard every change the workspace holds, back to the last commit. */
  discardAll: () => void;
  preview: PreviewDrafts;
  /** Undo one row: a deletion comes back, and a move goes home. */
  restore: (path: string) => void;
}
