//! The source browser's push and panel model: what a push is, what the page
//! and the Changes panel read back, and the three row actions they ask the
//! browser for. The changes themselves live in the workspace (`./workspace`);
//! this module holds the shapes that cross the boundary.

import type { WorkspaceChange } from "./workspace/types";

/** Where the last push landed (`newBranch`: the push created `branch`). */
export interface PushedTo {
  branch: string;
  newBranch: boolean;
}

/** Change/push state reported to the page (the Changes panel renders it). */
export interface SourceBrowserState {
  /** The workspace's changes, as of the last derive. */
  files: readonly WorkspaceChange[];
  pushError: string;
  pushed: PushedTo | null;
  pushing: boolean;
  /** Bumped on every change: a key for views rebuilt from `files`. */
  revision: number;
  /** The commit the pod is based on, when the browsed tip has moved on since —
   * pushing from it may conflict. */
  stale: string | null;
}

/** A push the Changes panel asks for. `branch` names a new branch to commit
 * to (from the default branch's tip); omitted, the commit goes to the
 * default branch. */
export interface PushRequest {
  branch?: string;
  message: string;
}

/** Commits the changes as `request` asks; resolves whether the push landed. */
export type CommitDrafts = (request: PushRequest) => Promise<boolean>;

/** What the browser hands the page once it is mounted: the commit the Changes
 * form calls, and the three row actions its buttons call (each of which has
 * already asked its own confirmation). */
export interface DraftActions {
  commit: CommitDrafts;
  /** Discard one row's change: an edit goes back to the committed text, an
   * added file (text or upload) leaves the tree, and a moved file keeps its
   * move with the edit dropped. */
  discard: (path: string) => void;
  /** Discard every change the workspace holds, back to the last commit. */
  discardAll: () => void;
  /** Undo one row: a deletion comes back, and a move goes home. */
  restore: (path: string) => void;
}
