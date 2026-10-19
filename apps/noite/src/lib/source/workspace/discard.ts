//! Putting the commit back. Everything here works on the pod's filesystem, so
//! a discard leaves no draft behind: an added path is removed, an edit is
//! overwritten with the committed bytes from the object cache, and a rename is
//! walked back to the path the commit gave the file.

import { clearJournal, readObject, writeJournal } from "./checkout";
import { parentDir, projectPath } from "./types";
import type { Journal, WorkspaceChange, WorkspaceState } from "./types";

/** Where a moved row's bytes really came from: the row's own record, or the
 * journal, or the path itself when neither knows. */
const moveOrigin = (state: WorkspaceState, change: WorkspaceChange): string =>
  change.movedFrom ?? state.journal[change.path] ?? change.path;

/** `journal` without the record of one undone move. */
const dropJournal = (journal: Journal, path: string): Journal => {
  const kept: Journal = {};

  for (const [current, committed] of Object.entries(journal)) {
    if (current !== path) {
      kept[current] = committed;
    }
  }

  return kept;
};

/** Put the committed bytes of `origin` at `path`: a staged deletion comes
 * back, an edit goes back to the commit's text, and a moved file keeps its
 * place with its edit dropped. A blob the pod never cached is an error, not a
 * silently empty file. */
const restoreBytes = async (
  state: WorkspaceState,
  path: string,
  origin: string
): Promise<void> => {
  const entry = state.base.entries[origin];

  const bytes =
    entry === undefined ? null : await readObject(state.fs, entry.sha);

  if (bytes === null) {
    throw new Error(
      `workspace: there is no committed copy of ${origin} to restore`
    );
  }

  const abs = projectPath(path);
  await state.fs.mkdir(parentDir(abs), { recursive: true });
  await state.fs.writeFile(abs, bytes);
};

/** Throw one row away: an added file leaves the tree, everything else goes
 * back to the bytes the commit has. A move keeps its journal record — the file
 * still sits where the move put it, it just holds the committed text again. */
export const discardChange = async (
  state: WorkspaceState,
  change: WorkspaceChange
): Promise<void> => {
  if (change.kind === "added") {
    await state.fs.rm(projectPath(change.path), {
      force: true,
      recursive: true,
    });

    return;
  }

  const origin =
    change.kind === "moved" ? moveOrigin(state, change) : change.path;

  await restoreBytes(state, change.path, origin);
};

/** Walk a moved file back to the committed path and put the committed bytes
 * there, in case the move carried an edit. The journal is left alone: a
 * discard-all drops it wholesale, a single restore edits it. */
const moveHome = async (
  state: WorkspaceState,
  change: WorkspaceChange
): Promise<void> => {
  const origin = moveOrigin(state, change);
  const abs = projectPath(change.path);

  if (origin !== change.path && (await state.fs.exists(abs))) {
    const destination = projectPath(origin);
    await state.fs.rm(destination, { force: true, recursive: true });
    await state.fs.mkdir(parentDir(destination), { recursive: true });
    await state.fs.rename(abs, destination);
  }

  await restoreBytes(state, origin, origin);
};

/** The filesystem half of one row's discard, with no journal bookkeeping: an
 * added path goes, a move walks home, anything else gets its committed bytes
 * back. */
const undoOne = async (
  state: WorkspaceState,
  change: WorkspaceChange
): Promise<void> => {
  if (change.kind === "added") {
    await state.fs.rm(projectPath(change.path), {
      force: true,
      recursive: true,
    });

    return;
  }

  if (change.kind === "moved") {
    await moveHome(state, change);

    return;
  }

  await restoreBytes(state, change.path, change.path);
};

/** Walk a move back and forget it: the file returns to the committed path, and
 * the journal loses the move. */
export const restoreMove = async (
  state: WorkspaceState,
  change: WorkspaceChange
): Promise<void> => {
  await moveHome(state, change);
  state.journal = dropJournal(state.journal, change.path);
  await writeJournal(state.fs, state.journal);
};

/** Every change gone: the added paths are removed, every other path gets its
 * committed bytes back, moves walk home, and the journal is dropped. The
 * checkout is then the commit again, file for file. */
export const discardAll = async (
  state: WorkspaceState,
  changes: readonly WorkspaceChange[]
): Promise<void> => {
  await Promise.all(changes.map((change) => undoOne(state, change)));
  state.journal = {};
  await clearJournal(state.fs);
};
