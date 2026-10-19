//! The source tree's inline naming: the placeholder row an add parks while
//! pierre's own inline input names it, and the name rules this pane holds in
//! front of the commit. The tree wiring owns the rows and the pod, so this
//! module reaches them through the same host and keeps only the add it is
//! naming.

import { errorMessage } from "../errors";
import type { TreeRenameEvent } from "./pierre";
import { parentDir, renameInput, withoutSlash } from "./tree-menu";
import type { Toaster } from "./tree-menu";
import type { WorkspaceChange } from "./workspace/types";

/** The placeholder row an add parked in the tree while pierre's inline input
 * names it. An untouched name is no rename to pierre, so the row keeps this
 * path — and `isFolder` says which draft it becomes. */
export interface PendingAdd {
  isFolder: boolean;
  path: string;
}

/** What the naming flow needs from the tree wiring: the rows it stands for, the
 * add it lands and the pod it names against. */
export interface TreeNamingHost {
  /** The change the workspace derived for a path, when it has one. */
  changeAt: (path: string) => WorkspaceChange | undefined;
  /** Drop a row pierre still holds (removing an absent path throws). */
  dropRow: (path: string) => void;
  editable: () => boolean;
  /** Whether pierre still holds a path (its store, not the visible rows). */
  hasRow: (path: string) => boolean;
  /** The add that landed, as the tree wiring writes it. */
  landAdd: (add: PendingAdd) => void;
  /** A rename pierre applied to a row that is not this add's placeholder: the
   * tree wiring mirrors it into the pod as a move. */
  onRenamed: (event: TreeRenameEvent) => void;
  /** Add a row to pierre's store (throws when it refuses). */
  rowAdd: (row: string) => void;
  /** Start pierre's inline rename on `path`, taking the row back out if the
   * input is abandoned; false when the tree cannot rename. */
  startRenaming: (path: string) => boolean;
  toaster: Toaster;
  /** Whether the tree instance is mounted. */
  treeReady: () => boolean;
}

/** The naming surface the tree wiring and its listeners drive. */
export interface TreeNaming {
  /** Forget the placeholder being named (a tree rebuild drops its row). */
  clearPending: () => void;
  finishAdd: (event: TreeRenameEvent) => void;
  guardNameKey: (event: KeyboardEvent) => void;
  nameRefused: (error: string) => void;
  onNameBlur: (event: FocusEvent) => void;
  /** The path of the placeholder the input is naming, when there is one. */
  pendingPath: () => string | undefined;
  startAdd: (dir: string, isFolder: boolean) => void;
}

/** Why `leaf` cannot name a new entry, or null when it can. pierre refuses an
 * empty name and any "/" itself, and knows the paths its store holds; these are
 * the rest of the contract: a name no path may carry, or one a staged deletion
 * still claims — a push cannot both write and delete a path. */
const nameError = (
  leaf: string,
  change: WorkspaceChange | undefined
): string | null => {
  if (leaf === "" || leaf.includes("/")) {
    return null;
  }

  if (leaf === "." || leaf === "..") {
    return `"${leaf}" is not a usable name.`;
  }

  return change?.kind === "deleted" ? `"${leaf}" already exists.` : null;
};

export const createTreeNaming = (host: TreeNamingHost): TreeNaming => {
  /** The add the inline input is naming, if any (see `PendingAdd`). */
  let pendingAdd: PendingAdd | null = null;

  /** A free leaf in `dir` ("" or "a/b/") for the row the inline input names:
   * pierre's rename refuses to land on a path the tree already holds, and a
   * staged deletion still claims its own (a push cannot both write and delete
   * a path). */
  const uniqueLeaf = (dir: string, stem: string): string => {
    for (let n = 1; ; n += 1) {
      const leaf = n === 1 ? stem : `${stem}-${n}`;
      const path = `${dir}${leaf}`;

      const taken =
        host.hasRow(path) || host.changeAt(path)?.kind === "deleted";

      if (!taken) {
        return leaf;
      }
    }
  };

  /** pierre reports a rename through `finishAdd`; a name left untouched is no
   * rename at all, so the placeholder is this browser's to settle — one
   * microtask out, because pierre finishes its own state (including the row
   * move, or dropping the placeholder when the input is abandoned) after its
   * callbacks return. A placeholder pierre has already taken back out (Esc,
   * or a refusal) is nothing to land: the blur that closes the input arrives
   * after the removal, and landing there would leave a row the pod never got. */
  const settleAdd = (add: PendingAdd) => {
    queueMicrotask(() => {
      if (pendingAdd !== add) {
        return;
      }

      pendingAdd = null;

      if (host.hasRow(add.path)) {
        host.landAdd(add);
      }
    });
  };

  /** A New File / New Folder pick: the row goes in, pierre turns it into its
   * inline input (`removeIfCanceled` takes the row back out when the input is
   * abandoned), and the name it lands on becomes the file or folder the pod
   * gets. */
  const startAdd = (dir: string, isFolder: boolean) => {
    if (!host.editable() || !host.treeReady()) {
      return;
    }

    const prefix = dir === "" ? "" : `${dir}/`;
    const stem = isFolder ? "new-folder" : "untitled";
    const path = `${prefix}${uniqueLeaf(prefix, stem)}`;
    const row = isFolder ? `${path}/` : path;

    try {
      host.rowAdd(row);
    } catch (error) {
      host.toaster.notify(errorMessage(error));

      return;
    }

    pendingAdd = { isFolder, path };

    if (!host.startRenaming(path)) {
      pendingAdd = null;
      host.dropRow(row);
      host.toaster.notify("This tree cannot be changed.");
    }
  };

  /** Our name rules, in front of pierre's commit: Enter would take the name
   * and move the row, so a refused one is stopped while the input still has
   * it. A name pierre takes but reports as unchanged is settled here. */
  const guardNameKey = (event: KeyboardEvent) => {
    const add = pendingAdd;

    if (event.key !== "Enter" || add === null) {
      return;
    }

    const input = renameInput(event);

    if (input === null) {
      return;
    }

    const name = input.value.trim();
    const dir = parentDir(add.path);
    const path = dir === "" ? name : `${dir}/${name}`;
    const error = nameError(name, host.changeAt(path));

    if (error !== null) {
      event.preventDefault();
      event.stopPropagation();
      host.toaster.notify(error);

      return;
    }

    if (name === add.path.slice(add.path.lastIndexOf("/") + 1)) {
      settleAdd(add);
    }
  };

  /** The name input losing focus commits it (pierre's own semantics), so the
   * placeholder is settled either way: a reported rename clears it, an
   * untouched one lands here. */
  const onNameBlur = (event: FocusEvent) => {
    const add = pendingAdd;

    if (add === null || renameInput(event) === null) {
      return;
    }

    settleAdd(add);
  };

  /** pierre refused the name itself (empty, a "/" in it, a path its store
   * already holds): the input closes but the placeholder row stays, so the
   * pane takes it back out and says what happened. */
  const nameRefused = (error: string) => {
    const add = pendingAdd;
    pendingAdd = null;

    if (add !== null) {
      host.dropRow(add.isFolder ? `${add.path}/` : add.path);
    }

    host.toaster.notify(error);
  };

  /** pierre's inline input landed on a name: the placeholder becomes the file
   * the pod gets, or the empty folder it stood for. */
  const finishAdd = (event: TreeRenameEvent) => {
    const add = pendingAdd;
    pendingAdd = null;

    // Anything but the placeholder this browser parked is a row the checkout
    // or the browser already held: pierre renamed it, so it is a move.
    if (add === null || event.sourcePath !== add.path) {
      host.onRenamed(event);

      return;
    }

    const dest = withoutSlash(event.destinationPath);

    const error = nameError(
      dest.slice(dest.lastIndexOf("/") + 1),
      host.changeAt(dest)
    );

    if (error !== null) {
      // pierre moves the row after this callback returns: drop it then.
      const row = event.isFolder ? `${dest}/` : dest;
      queueMicrotask(() => {
        host.dropRow(row);
      });
      host.toaster.notify(error);

      return;
    }

    host.landAdd({ isFolder: event.isFolder, path: dest });
  };

  return {
    clearPending: () => {
      pendingAdd = null;
    },
    finishAdd,
    guardNameKey,
    nameRefused,
    onNameBlur,
    pendingPath: () => pendingAdd?.path,
    startAdd,
  };
};
