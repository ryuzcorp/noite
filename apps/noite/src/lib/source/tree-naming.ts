//! The source tree's inline naming: the placeholder row an add parks while
//! pierre's own inline input names it, and the name rules this pane holds in
//! front of the commit. The tree wiring owns the rows and the pod, so this
//! module reaches them through the same host; the naming lifecycle itself is
//! `./naming-state`, which refuses a callback that lands after the placeholder
//! was taken back (that used to arrive as a pod rename of a path that never
//! existed).

import { errorMessage } from "../errors";
import {
  clearNaming,
  finishNaming,
  newNamingMachine,
  refuseNaming,
  settleNaming,
  startNaming,
} from "./naming-state";
import type { NamingMachine, PendingAdd } from "./naming-state";
import type { TreeRenameEvent } from "./pierre";
import { parentDir, renameInput, withoutSlash } from "./tree-menu";
import type { Toaster } from "./tree-menu";
import type { WorkspaceChange } from "./workspace/types";

export type { PendingAdd } from "./naming-state";

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
 * empty name and any "/" in it, and knows the paths its store holds; these are
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
  let machine: NamingMachine = newNamingMachine();

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
      const decision = settleNaming(machine, add, host.hasRow(add.path));
      ({ machine } = decision);

      if (decision.land !== null) {
        host.landAdd(decision.land);
      }
    });
  };

  /** A New File / New Folder pick: the row goes in, pierre turns it into its
   * inline input (`removeIfCanceled` takes the row back out when the input is
   * abandoned), and the name it lands on becomes the file or folder the pod
   * gets. A second pick while one is being named is refused: it would orphan
   * the first placeholder's input. */
  const startAdd = (dir: string, isFolder: boolean) => {
    if (!host.editable() || !host.treeReady()) {
      return;
    }

    const prefix = dir === "" ? "" : `${dir}/`;
    const stem = isFolder ? "new-folder" : "untitled";
    const path = `${prefix}${uniqueLeaf(prefix, stem)}`;
    const row = isFolder ? `${path}/` : path;
    const started = startNaming(machine, { isFolder, path });

    if (!started.accepted) {
      return;
    }

    ({ machine } = started);

    try {
      host.rowAdd(row);
    } catch (error) {
      host.toaster.notify(errorMessage(error));

      return;
    }

    if (!host.startRenaming(path)) {
      machine = clearNaming(machine);
      host.dropRow(row);
      host.toaster.notify("This tree cannot be changed.");
    }
  };

  /** Our name rules, in front of pierre's commit: Enter would take the name
   * and move the row, so a refused one is stopped while the input still has
   * it. A name pierre takes but reports as unchanged is settled here. */
  const guardNameKey = (event: KeyboardEvent) => {
    const add = machine.state._tag === "Naming" ? machine.state.add : null;

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
    const add = machine.state._tag === "Naming" ? machine.state.add : null;

    if (add === null || renameInput(event) === null) {
      return;
    }

    settleAdd(add);
  };

  /** pierre refused the name itself (empty, a "/" in it, a path its store
   * already holds): the input closes but the placeholder row stays, so the
   * pane takes it back out and says what happened. */
  const nameRefused = (error: string) => {
    const decision = refuseNaming(machine, error);
    ({ machine } = decision);

    if (decision.refused) {
      return;
    }

    if (decision.drop !== null) {
      host.dropRow(decision.drop);
    }

    if (decision.notify !== null) {
      host.toaster.notify(decision.notify);
    }
  };

  /** pierre's inline input landed on a name: the placeholder becomes the file
   * the pod gets, or the empty folder it stood for. */
  const finishAdd = (event: TreeRenameEvent) => {
    const dest = withoutSlash(event.destinationPath);
    const naming = machine.state._tag === "Naming" ? machine.state.add : null;

    // A name our rules refuse is dropped once pierre has finished moving the
    // row; the machine forgets the placeholder first, so the blur that follows
    // cannot land it.
    if (naming !== null && event.sourcePath === naming.path) {
      const error = nameError(
        dest.slice(dest.lastIndexOf("/") + 1),
        host.changeAt(dest)
      );

      if (error !== null) {
        const row = event.isFolder ? `${dest}/` : dest;
        machine = clearNaming(machine);
        queueMicrotask(() => {
          host.dropRow(row);
        });
        host.toaster.notify(error);

        return;
      }
    }

    const decision = finishNaming(machine, {
      destinationPath: dest,
      isFolder: event.isFolder,
      sourcePath: event.sourcePath,
    });

    ({ machine } = decision);

    if (decision.land !== null) {
      host.landAdd(decision.land);

      return;
    }

    if (decision.rename !== null) {
      host.onRenamed(decision.rename);
    }
  };

  return {
    clearPending: () => {
      machine = clearNaming(machine);
    },
    finishAdd,
    guardNameKey,
    nameRefused,
    onNameBlur,
    pendingPath: () =>
      machine.state._tag === "Naming" ? machine.state.add.path : undefined,
    startAdd,
  };
};
