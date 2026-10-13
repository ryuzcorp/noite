//! The source tree's row flows: the moves, the deletes and the discards that
//! write to the pod and keep pierre's store in step with it. Every gesture is a
//! filesystem write — a move is a rename the workspace journals, a delete is a
//! removal, an add is an empty file or a folder — and the rows follow the
//! checkout, which the wiring re-lists after each one. The live `FileTree`
//! belongs to `./tree`, so this module reaches the rows through the `rows`
//! accessor its host carries.

import { errorMessage } from "../errors";
import { confirmDialog } from "../ui/confirm";
import type { IntelPosition } from "./intel-protocol";
import type {
  TreeDropContext,
  TreeDropResult,
  TreeRenameEvent,
} from "./pierre";
import { dropDestination, withoutSlash } from "./tree-menu";
import type { PendingAdd } from "./tree-naming";
import type { Workspace, WorkspaceChange } from "./workspace/types";

/** The delete confirmation's consequence over `files` files: the committed
 * ones the next push removes from the repository; files that only exist in the
 * pod are simply taken back out. */
const deleteMessage = (files: number, committed: number): string => {
  if (committed === 0) {
    return files === 1
      ? "It is not pushed yet, so it is just discarded."
      : "Nothing here is pushed yet, so it is just discarded.";
  }
  const count = `${committed} ${committed === 1 ? "file" : "files"}`;
  return `Push removes ${count} from the repository.`;
};

/** The live tree's rows, as the wiring hands them to the flows: pierre's store
 * behind a surface the flows never rebuild. */
export interface TreeRowStore {
  /** Add a row to pierre's store (throws when it refuses). */
  add: (path: string) => void;
  /** Drop a row pierre still holds (removing an absent path throws). */
  drop: (path: string) => void;
  /** Whether pierre still holds a path (its store, not the visible rows). */
  has: (path: string) => boolean;
}

/** What the row flows need from the tree wiring. */
export interface TreeRowsHost {
  aborted: () => boolean;
  /** The change the workspace derived for a path, when it has one. */
  changeAt: (path: string) => WorkspaceChange | undefined;
  editable: () => boolean;
  /** The file rows under a folder ("" at the root). */
  filesUnder: (dir: string) => string[];
  /** The pane's `followMove(from, to)`: re-keys the open file's text and path. */
  followMove: (from: string, to: string) => void;
  getCurrentPath: () => string | null;
  /** The pane's toast corner, for a write the pod refused. */
  notify: (message: string) => void;
  openFile: (path: string, caret?: IntelPosition) => Promise<boolean>;
  placeCaret: (position: IntelPosition) => void;
  report: () => void;
  /** Derive again and put the rows in step with the pod (see `./tree`). */
  resync: () => Promise<void>;
  /** The rows in pierre's store. */
  rows: TreeRowStore;
  signal: AbortSignal;
  /** The pane's `syncOpen()`: put the open file back in step with the pod. */
  syncOpen: () => Promise<void>;
  workspace: Workspace;
}

/** The row flows' surface for the tree wiring. */
export interface TreeRows {
  canDrop: (drop: TreeDropContext) => boolean;
  deleteRows: (paths: readonly string[]) => Promise<void>;
  discardChange: (path: string) => void;
  landAdd: (add: PendingAdd) => void;
  landDrops: (drop: TreeDropResult) => void;
  renamedRow: (event: TreeRenameEvent) => void;
  restorePath: (path: string) => void;
}

export const createTreeRows = (host: TreeRowsHost): TreeRows => {
  /** The pod moved: derive again, put the rows in step with the fresh listing,
   * and tell the page (an earlier push outcome is superseded). */
  const settle = async (): Promise<void> => {
    await host.resync();
    host.report();
  };

  /** One row's move in the pod. A file is a single rename; a folder takes
   * everything under it along, which is the same call. pierre has already
   * moved its own rows (a drag, or its inline rename), so nothing here touches
   * them: the re-list settles whichever side the other has not seen. */
  const moveRow = async (from: string, to: string): Promise<void> => {
    if (from === to) {
      return;
    }
    try {
      await host.workspace.rename(from, to);
    } catch (error) {
      host.notify(errorMessage(error));
    }
    // The pane's live text and its open path re-key with the move.
    host.followMove(from, to);
  };

  /** The pane follows the file it has open when a move carried it off: the
   * editor and `?file=` land on its new path, and the file re-reads from there
   * (the caret restarts at the top — pierre's editor has no selection to carry
   * over). */
  const followOpen = (wasOpen: string | null) => {
    const path = host.getCurrentPath();
    if (path === null || path === wasOpen) {
      return;
    }
    void host.openFile(path);
  };

  /** Whether pierre may offer this drop. A row of either kind is a target:
   * pierre reads a file row as the folder that holds it (the root, for a
   * top-level file), which is how a nested file gets dragged back out — so
   * the only refusal left is a path the pod has staged for deletion (pierre's
   * store keeps no row there to collide with) and, handled by pierre itself, a
   * folder dropped into itself or a row that already holds the same name (that
   * arrives through `onDropError`, tree untouched). */
  const canDrop = (drop: TreeDropContext): boolean => {
    if (!host.editable()) {
      return false;
    }
    return drop.draggedPaths.every(
      (path) =>
        host.changeAt(dropDestination(path, drop.target))?.kind !== "deleted"
    );
  };

  /** pierre has already moved the rows in its store when it reports a drop;
   * mirror every one into the pod, then let the pane follow the file it has
   * open. */
  const landDrops = (drop: TreeDropResult) => {
    if (!host.editable() || drop.draggedPaths.length === 0) {
      return;
    }
    const wasOpen = host.getCurrentPath();
    void (async () => {
      await Promise.all(
        drop.draggedPaths.map((dragged) =>
          moveRow(
            withoutSlash(dragged),
            withoutSlash(dropDestination(dragged, drop.target))
          )
        )
      );
      await settle();
      followOpen(wasOpen);
    })();
  };

  /** A rename pierre applied to a row the tree already held is a move: the row
   * keeps its bytes at a new path, and the workspace journals the rename so
   * the push replays one move per file. */
  const renamedRow = (event: TreeRenameEvent) => {
    if (!host.editable()) {
      return;
    }
    const wasOpen = host.getCurrentPath();
    void (async () => {
      await moveRow(
        withoutSlash(event.sourcePath),
        withoutSlash(event.destinationPath)
      );
      await settle();
      followOpen(wasOpen);
    })();
  };

  /** The add lands on the name the row carries: an empty file the pane opens,
   * or a folder — git cannot store an empty folder, so that one is not a
   * change and never pushed. */
  const landAdd = (add: PendingAdd) => {
    void (async () => {
      try {
        await (add.isFolder
          ? host.workspace.mkdir(add.path)
          : host.workspace.writeText(add.path, ""));
      } catch (error) {
        host.notify(errorMessage(error));
      }
      await settle();
      if (add.isFolder) {
        return;
      }
      // A file that just appeared should be ready to type in: the open parks
      // the caret and pierre's attach places it, which needs no click (pierre
      // only takes text where its own caret sits). The row pierre named is its
      // own — it moves, selects and focuses it as the rename lands — so the
      // caret is asked for again once that has had its frame.
      await host.openFile(add.path, { character: 0, line: 0 });
      // oxlint-disable-next-line promise/avoid-new -- frame-paced wait: the row pierre focused hands the DOM back on its own render
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      if (host.getCurrentPath() === add.path) {
        host.placeCaret({ character: 0, line: 0 });
      }
    })();
  };

  /** A menu Delete: one confirmation for every row it acts on (the
   * right-clicked row, or the whole multi-selection it belongs to), then each
   * is removed from the pod. Rows inside a selected folder go with the folder. */
  const deleteRows = async (paths: readonly string[]) => {
    if (!host.editable() || paths.length === 0) {
      return;
    }
    const targets = paths.filter(
      (path) =>
        !paths.some(
          (other) =>
            other !== path && other.endsWith("/") && path.startsWith(other)
        )
    );
    const files = new Set(
      targets.flatMap((path) =>
        path.endsWith("/")
          ? host.filesUnder(withoutSlash(path))
          : [withoutSlash(path)]
      )
    );
    const committed = [...files].filter(
      (one) => host.changeAt(one)?.kind !== "added"
    ).length;
    const [only] = targets;
    const ok = await confirmDialog({
      confirmLabel: "Delete",
      message: deleteMessage(files.size, committed),
      signal: host.signal,
      title:
        targets.length === 1 && only !== undefined
          ? `Delete ${withoutSlash(only)}?`
          : `Delete ${targets.length} items?`,
    });
    if (!ok || host.aborted()) {
      return;
    }
    await Promise.all(
      targets.map(async (path) => {
        try {
          await host.workspace.remove(withoutSlash(path));
        } catch (error) {
          host.notify(errorMessage(error));
        }
      })
    );
    await settle();
    await host.syncOpen();
  };

  /** Discard one row's change from the Changes panel: the pod goes back to the
   * committed bytes (an added file leaves it), and the pane follows whatever
   * the file is now — the committed text, or nothing. */
  const discardChange = (path: string) => {
    if (!host.editable()) {
      return;
    }
    void (async () => {
      try {
        await host.workspace.discard(path);
      } catch (error) {
        host.notify(errorMessage(error));
      }
      await settle();
      await host.syncOpen();
    })();
  };

  /** Undo from the Changes panel: a staged deletion comes back from the commit
   * cache, and a move goes home — the file returns to the committed path, and
   * the pane follows it there. */
  const restorePath = (path: string) => {
    if (!host.editable()) {
      return;
    }
    const change = host.changeAt(path);
    const origin = change?.kind === "moved" ? change.movedFrom : undefined;
    // Something else claimed the committed path (a new file made there while
    // the move was staged): the undo cannot land, and pierre's store would
    // refuse it anyway.
    if (origin !== undefined && host.rows.has(origin)) {
      host.notify(`"${origin}" already exists.`);
      return;
    }
    const wasOpen = host.getCurrentPath();
    void (async () => {
      try {
        await host.workspace.restore(path);
        if (origin !== undefined) {
          host.followMove(path, origin);
        }
      } catch (error) {
        host.notify(errorMessage(error));
      }
      await settle();
      followOpen(wasOpen);
      await host.syncOpen();
    })();
  };

  return {
    canDrop,
    deleteRows,
    discardChange,
    landAdd,
    landDrops,
    renamedRow,
    restorePath,
  };
};
