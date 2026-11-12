//! Which file a browse opens: the URL's `?file=` when the checkout holds that
//! path, else the repository's front door — `package.json`, then `README.md`,
//! then the first file the tree shows. A checkout with no files at all is its
//! own answer: only then does the pane say the repository has no files yet.
//!
//! This is the closed outcome the browser transitions the pane into when a
//! checkout opens (`PaneEvents.Emptied` or `PaneEvents.Requested` in
//! `./pane-view`), never a note painted around the machine.

import { Data } from "effect";

import { sortTreePaths } from "./tree-menu";

/** The file a browse opens when it opens. */
export type InitialFile = Data.TaggedEnum<{
  /** The checkout holds no files at all. */
  Empty: Record<never, never>;
  /** The path to open. */
  Opened: { path: string };
}>;

export const InitialFiles = Data.taggedEnum<InitialFile>();

/** The repository's front door, when it has one. */
const FRONT_DOOR = ["package.json", "README.md"] as const;

/** Choose the file a browse opens from `paths` (every row the tree holds, in
 * any order) and the URL's `?file=` (`""` when the URL names none). */
export const initialFile = (
  paths: readonly string[],
  wanted: string
): InitialFile => {
  if (paths.length === 0) {
    return InitialFiles.Empty();
  }

  if (wanted !== "" && paths.includes(wanted)) {
    return InitialFiles.Opened({ path: wanted });
  }

  const held = new Set(paths);

  for (const name of FRONT_DOOR) {
    if (held.has(name)) {
      return InitialFiles.Opened({ path: name });
    }
  }

  // The first file in the tree's own order (folders first, then the files).
  const [first] = sortTreePaths([...paths]);

  return first === undefined
    ? InitialFiles.Empty()
    : InitialFiles.Opened({ path: first });
};
