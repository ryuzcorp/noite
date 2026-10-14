//! Sending the pod's changes and settling the pod on what came back. The
//! payload is exactly the commit route's shape — writes (base64 when the bytes
//! are not text), the journal's renames, and the paths the branch no longer has
//! — and the commit's target decides what the pod holds next: a push to the
//! pod's own branch makes the pod its own new base (the filesystem is already
//! the committed content, so nothing is re-downloaded), while a push to any
//! other branch leaves this branch alone and puts the pod back on the base it
//! was committed from.

import { bytesToBase64 } from "../../bytes";
import { deriveChanges, fileSha, listFiles } from "./changes";
import { clearJournal, objectPath, writeBase, writeObject } from "./checkout";
import { discardAll } from "./discard";
import { isBinary } from "./git";
import { projectPath } from "./types";
import type {
  BaseEntry,
  Journal,
  PushFile,
  PushMove,
  PushPayload,
  WorkspaceChange,
  WorkspaceFs,
  WorkspaceState,
} from "./types";

const DECODER = new TextDecoder();

/** The mode a path the workspace added gets in the base index: the pod's
 * filesystem has no execute bit to read, and a file written by hand is a plain
 * one. A path the commit already knew keeps the mode git gave it. */
const ADDED_MODE = "100644";

/** One changed file as the commit write it is: its text, or its bytes as
 * base64 when they are not text at all (the runner decodes them back). */
const pushFile = async (
  fs: WorkspaceFs,
  change: WorkspaceChange
): Promise<PushFile> => {
  const bytes = await fs.readFile(projectPath(change.path));
  if (isBinary(bytes)) {
    return {
      content: bytesToBase64(bytes),
      encoding: "base64",
      path: change.path,
    };
  }
  return { content: DECODER.decode(bytes), path: change.path };
};

/** Everything the branch does not have any more: the rows that are staged
 * removals, plus the committed path behind a move the journal never recorded
 * (the commit writes the new path, and that copy has to go). */
const deletePaths = (
  changes: readonly WorkspaceChange[],
  journal: Journal
): string[] => {
  const deletes: string[] = [];
  for (const change of changes) {
    if (change.kind === "deleted") {
      deletes.push(change.path);
      continue;
    }
    const { movedFrom } = change;
    if (
      change.kind === "moved" &&
      movedFrom !== undefined &&
      journal[change.path] !== movedFrom
    ) {
      deletes.push(movedFrom);
    }
  }
  return deletes;
};

/** The renames the commit replays, straight from the journal: a move the UI
 * never journalled travels as a write plus a deletion instead. */
const movePaths = (
  changes: readonly WorkspaceChange[],
  journal: Journal
): PushMove[] => {
  const moves: PushMove[] = [];
  for (const change of changes) {
    const { movedFrom } = change;
    if (
      change.kind === "moved" &&
      movedFrom !== undefined &&
      journal[change.path] === movedFrom
    ) {
      moves.push({ from: movedFrom, to: change.path });
    }
  }
  return moves;
};

/** What the Changes panel's Push sends, read off the pod: every changed path
 * as a write, every rename the journal knows, and every path the commit should
 * drop. */
export const pushPayload = async (
  state: WorkspaceState
): Promise<PushPayload> => {
  const { fs, journal } = state;
  const changes = await deriveChanges(state);
  const files = await Promise.all(
    changes
      .filter((change) => change.kind !== "deleted")
      .map((change) => pushFile(fs, change))
  );
  return {
    deletes: deletePaths(changes, journal),
    files,
    moves: movePaths(changes, journal),
  };
};

/** Re-base the pod on the commit that was just made: the checkpoint is the
 * filesystem as it stands, so every file is hashed once more (unchanged files
 * answer from the cache), the blobs the commit brought are cached for later
 * diffs, and the journal is dropped. `baseSha` becomes the commit. */
export const markPushed = async (
  state: WorkspaceState,
  sha: string
): Promise<void> => {
  const { cache, fs } = state;
  const files = await listFiles(fs, state.base);
  const entries = await Promise.all(
    files.map(async (file): Promise<[string, BaseEntry]> => {
      const digest = await fileSha(fs, cache, file);
      if (!(await fs.exists(objectPath(digest.sha)))) {
        await writeObject(
          fs,
          digest.sha,
          digest.bytes ?? (await fs.readFile(projectPath(file.path)))
        );
      }
      return [
        file.path,
        {
          mode: state.base.entries[file.path]?.mode ?? ADDED_MODE,
          sha: digest.sha,
        },
      ];
    })
  );
  state.base = { baseSha: sha, entries: Object.fromEntries(entries) };
  await writeBase(fs, state.base);
  state.journal = {};
  await clearJournal(fs);
};

/** The push went to another branch. This branch's base did not move — the
 * commit the user just made lives on the branch they named — so the pod goes
 * back to the base it was committed from: every change reverted to its
 * committed bytes, the journal dropped, and `baseSha` left where it was. */
export const revertToBase = async (state: WorkspaceState): Promise<void> => {
  await discardAll(state, await deriveChanges(state));
};
