//! The source browser's commit model: what a push is, what the page and the
//! Changes panel read back, and the row actions they ask the browser for. The
//! changes themselves live in the page's edit session (`./session`); this
//! module holds the shapes that cross the boundary between them.

import type { SourceChange } from "./session";

/** Why the browsed checkout is read-only: `""` when it is editable, else
 * `tag`/`commit` (a tag or a raw commit sha — the runner can only commit to a
 * branch) or `role` (the viewer's app role is below `push`). */
export type ReadOnlyRef = "" | "tag" | "commit" | "role";

/** Where the last push landed (`newBranch`: the push created `branch`), and
 * the branch it started from — the base a pull request from `branch` targets. */
export interface PushedTo {
  base: string;
  branch: string;
  newBranch: boolean;
}

/** One failed push: the runner's own words (an HTTP status and its text). */
export interface OperationFailure {
  readonly message: string;
}

/** Change and push state reported to the page (the Changes panel renders it,
 * and the top bar's badge reads the count off `files`). */
export interface SourceBrowserState {
  /** The session's changes, as of the last edit. */
  files: readonly SourceChange[];
  /** Why the last push failed (null = it did not): the Changes form's line. */
  pushError: OperationFailure | null;
  pushed: PushedTo | null;
  pushing: boolean;
  /** Why the installed checkout cannot be edited (see `ReadOnlyRef`). */
  readOnly: ReadOnlyRef;
  /** Bumped on every change: a key for views rebuilt from `files`. */
  revision: number;
}

/** A push the Changes panel asks for. `branch` names a new branch to commit
 * to, started at the tip of the branch being browsed; omitted, the commit goes
 * to the browsed branch itself. */
export interface PushRequest {
  branch?: string;
  message: string;
}

/** Commits the session's changes as `request` asks; resolves whether the push
 * landed. */
export type CommitDrafts = (request: PushRequest) => Promise<boolean>;

/** What the browser hands the page once it is mounted: the commit the Changes
 * form calls and the row actions their buttons call (each of which has already
 * asked its own confirmation). */
export interface DraftActions {
  commit: CommitDrafts;
  /** Discard one row's change: an edit goes back to the committed text, an
   * added file (text or upload) leaves the tree, and a moved file keeps its
   * move with the edit dropped. */
  discard: (path: string) => void;
  /** Discard every change the page holds, back to the last commit. */
  discardAll: () => void;
  /** Undo one row: a deletion comes back, and a move goes home. */
  restore: (path: string) => void;
}
