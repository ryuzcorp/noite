//! The source tree wiring: the `@pierre/trees` instance the pane mounts, its
//! options and composition (context menu, inline renaming, drag and drop), and
//! the flows it composes. The pod is the tree's data: its rows are the checkout
//! (every file, plus the folders that hold none), every gesture is a filesystem
//! write, and the markers come from the workspace's own derive. The row flows
//! live in `./tree-rows` and the upload UI in `./tree-uploads`; this module
//! wires both through `host` and keeps pierre's store in step with the pod.

import { errorMessage } from "../errors";
import type { SearchParam } from "../search-param";
import type { IntelPosition } from "./intel-protocol";
import type {
  Tree,
  TreeGitStatus,
  TreeStatusEntry,
  TreesModule,
} from "./pierre";
import {
  isTreeRow,
  menuDir,
  newToaster,
  newTreeMenu,
  openTreeMenu,
  renameInput,
  sortTreePaths,
  withoutSlash,
} from "./tree-menu";
import type { MenuTarget, Toaster, TreeMenu } from "./tree-menu";
import { createTreeNaming } from "./tree-naming";
import { createTreeRows } from "./tree-rows";
import type { TreeRowStore } from "./tree-rows";
import { createTreeUploads } from "./tree-uploads";
import type {
  ChangeKind,
  CheckoutListing,
  Workspace,
  WorkspaceChange,
} from "./workspace/types";

/** How a change paints in the tree: pierre's own names, one per change kind. */
const STATUS: Record<ChangeKind, TreeGitStatus> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  moved: "renamed",
};

/** The commit's own config files, the sensible thing to open when a browse
 * names no file. */
const CONFIG_FILES = [
  "cloudflare.config.ts",
  "wrangler.jsonc",
  "wrangler.toml",
] as const;

/** What the tree wiring needs from the browser and the editor pane. */
export interface TreeHost {
  aborted: () => boolean;
  /** The workspace's changes, as of the last derive: what the markers paint
   * and what a name may not claim (a staged deletion). */
  changes: () => readonly WorkspaceChange[];
  editable: () => boolean;
  file: SearchParam<string>;
  /** The pane's `followMove(from, to)`: re-keys the open file's text and path. */
  followMove: (from: string, to: string) => void;
  getCurrentPath: () => string | null;
  openFile: (path: string, caret?: IntelPosition) => Promise<boolean>;
  placeCaret: (position: IntelPosition) => void;
  /** The page's report: a change happened, so an earlier push outcome is
   * superseded. */
  report: () => void;
  signal: AbortSignal;
  /** The pane's `syncOpen()`: put the open file back in step with the pod. */
  syncOpen: () => Promise<void>;
  treeEl: HTMLElement;
  trees: TreesModule;
  /** The checkout the rows read and write, as of now: a branch switch installs
   * another one under this same tree (the rows are rebuilt from its listing). */
  workspace: () => Workspace;
}

/** The tree wiring's surface for the browser. */
export interface TreeWiring {
  /** Paint the checkout: every file and every empty folder as a row, and the
   * commit's own markers. Answers the file to open first, if any. */
  buildTree: (listing: CheckoutListing) => string | undefined;
  cleanUp: () => void;
  /** Discard one row's change (see `discardChange`). */
  discard: (path: string) => void;
  /** Discard every change and put the rows back on the checkout. */
  discardAll: () => void;
  /** Whether pierre still holds a path (its store, not the visible rows). */
  hasRow: (path: string) => boolean;
  /** The pane's toast corner, for the composition's own notices. */
  notify: (message: string) => void;
  restorePath: (path: string) => void;
  /** Derive again and put the rows in step with the pod (a push can change
   * what the checkout holds without the pane having touched it). */
  resync: () => Promise<void>;
  /** Push the changes into the tree's status markers, if they changed. */
  syncStatus: () => void;
}

/** The markers as a memo key: an unchanged set never repaints the tree. */
const statusKey = (entries: readonly TreeStatusEntry[]) =>
  entries.map((entry) => `${entry.path}\u0000${entry.status}`).join("\n");

/** The changes as pierre paints them: one marker per changed path, under the
 * status its kind names. */
const markers = (changes: readonly WorkspaceChange[]): TreeStatusEntry[] =>
  changes.map((change) => ({
    path: change.path,
    status: STATUS[change.kind],
  }));

/** The paths the checkout's rules exclude, as pierre paints them: its own
 * `ignored` status, which dims the row — and a folder under it with it. */
const ignoredMarkers = (listing: CheckoutListing): TreeStatusEntry[] => [
  ...listing.ignoredDirs.map((dir) => ({
    path: `${dir}/`,
    status: "ignored" as const,
  })),
  ...listing.ignoredFiles.map((path) => ({
    path,
    status: "ignored" as const,
  })),
];

/** The checkout as the tree's rows: `dir/` for a folder, the path itself for a
 * file. A folder the checkout holds no file under is a row of its own — the
 * only place such a folder shows — and so is a path the rules exclude, which
 * the markers below paint dimmed. */
const rowPaths = (listing: CheckoutListing): string[] => [
  ...listing.files,
  ...listing.ignoredFiles,
  ...listing.dirs.map((dir) => `${dir}/`),
  ...listing.ignoredDirs.map((dir) => `${dir}/`),
];

export const createTreeWiring = (host: TreeHost): TreeWiring => {
  let tree: Tree | undefined;
  /** The row paths pierre holds, as one set: pierre's store cannot be
   * enumerated, so the wiring keeps the same set beside it. */
  let held = new Set<string>();
  /** The paths the checkout's rules exclude, as the tree paints them (dimmed —
   * see `ignoredMarkers`) and as one set the row flows read. A listing replaces
   * both, so they always describe the rows in the tree. */
  let ignored: TreeStatusEntry[] = [];
  let excluded = new Set<string>();
  /** The open context menu, torn down with the pane (it lives on
   * `document.body`, outside the panes ilha rebuilds). */
  let menu: TreeMenu | null = null;
  const toaster: Toaster = newToaster();

  /** Whether pierre still holds a path (its store, not the visible rows). */
  const hasRow = (path: string): boolean =>
    tree !== undefined && tree.getItem(path) !== null;

  /** Drop a row pierre still holds — removing an absent path throws. */
  const dropRow = (path: string) => {
    if (hasRow(path)) {
      tree?.remove(path);
    }
    held.delete(path);
  };

  /** The live rows, as the row flows reach them (see `TreeRowStore`). */
  const store: TreeRowStore = {
    add: (path) => {
      tree?.add(path);
      held.add(path);
    },
    drop: dropRow,
    has: hasRow,
  };

  /** The change the workspace derived for `path`, when it has one. */
  const changeAt = (path: string): WorkspaceChange | undefined =>
    host.changes().find((change) => change.path === path);

  /** The file rows under a folder ("" at the root): what a folder delete
   * counts, and what a delete of it takes with it. */
  const filesUnder = (dir: string): string[] => {
    const prefix = dir === "" ? "" : `${dir}/`;
    return [...held].filter(
      (path) => !path.endsWith("/") && path.startsWith(prefix)
    );
  };

  /** Take one listing's excluded paths as the tree's own: the dimmed markers,
   * and the set the row flows ask about (`ignoredPath`). */
  const holdIgnored = (listing: CheckoutListing) => {
    ignored = ignoredMarkers(listing);
    excluded = new Set([...listing.ignoredDirs, ...listing.ignoredFiles]);
  };

  /** Whether the checkout's rules exclude a row — a path git is not tracking,
   * whatever the pod holds there. A delete does not count one as part of the
   * repository, and nothing about it is ever pushed. */
  const ignoredPath = (path: string): boolean =>
    excluded.has(withoutSlash(path));

  /** Push the changes into the tree: the markers of the derive, plus the paths
   * the checkout's rules exclude, which pierre paints dimmed beside them. A
   * no-op while neither set moved, so typing never repaints the tree. */
  let treeStatusKey = "";
  const syncStatus = () => {
    const entries = [...markers(host.changes()), ...ignored];
    const key = statusKey(entries);
    if (key === treeStatusKey) {
      return;
    }
    treeStatusKey = key;
    tree?.setGitStatus(entries);
  };
  /** The placeholder path the inline input is naming, if any. The naming flow
   * below owns it, but the flows it feeds need `resync` first — so this cell
   * is assigned with the naming flow and `resync` reads through it. */
  let pendingPath: (() => string | undefined) | undefined = undefined;

  /** Derive the pod again and put the rows in step with it: the listing is the
   * truth, so a row the checkout no longer has goes (deepest first — pierre
   * refuses to remove a folder that still holds children) and one it gained
   * comes in (shallowest first). A row pierre moved itself is already where the
   * listing says it is, so it costs nothing. The add being named stays: its
   * placeholder is in no listing yet, and dropping it would kill the inline
   * input mid-name. A derive or a row pierre refuses is reported and leaves
   * the rows as they are. */
  const syncRows = async (): Promise<void> => {
    try {
      await host.workspace().refresh();
      const listing = await host.workspace().listing();
      holdIgnored(listing);
      const next = rowPaths(listing);
      const wanted = new Set(next);
      // Every folder the listing's rows sit under. A folder row the pod no
      // longer names in its own right is not a row to drop while these hold it
      // up: pierre refuses to remove a folder that still has children, and
      // those children are exactly what implies the folder now — an empty or
      // ignored folder that just gained a file is the usual way to get here.
      const implied = new Set<string>();
      for (const row of next) {
        const parts = row.split("/");
        for (let i = 1; i < parts.length; i += 1) {
          implied.add(`${parts.slice(0, i).join("/")}/`);
        }
      }
      const pending = pendingPath === undefined ? undefined : pendingPath();
      for (const path of [...held].toSorted((a, b) => b.length - a.length)) {
        if (
          !wanted.has(path) &&
          path !== pending &&
          !(path.endsWith("/") && implied.has(path))
        ) {
          dropRow(path);
        }
      }
      for (const path of next.toSorted((a, b) => a.length - b.length)) {
        // A row pierre moved itself (its inline rename, a drag) is already in
        // its store under the new path: the mirror takes it from there.
        if (hasRow(path)) {
          held.add(path);
          continue;
        }
        store.add(path);
      }
      syncStatus();
    } catch (error) {
      toaster.notify(errorMessage(error));
    }
  };

  /** The runs are one at a time, and the last ask wins: a gesture, the pod's
   * own watcher and a `.gitignore` write all ask for one, and two listings
   * landing out of order would put back a row the pod no longer holds (the
   * empty-folder and ignored-folder rows are the ones nothing else implies).
   * A caller that arrives mid-run is answered by the run after it. */
  let syncing: Promise<void> | null = null;
  let again = false;
  const resync = async (): Promise<void> => {
    if (syncing !== null) {
      again = true;
      await syncing;
      return;
    }
    do {
      again = false;
      syncing = syncRows();
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one run at a time is the point: a later listing must not overtake an earlier one.
        await syncing;
      } finally {
        syncing = null;
      }
    } while (again);
  };

  const flow = createTreeRows({
    aborted: host.aborted,
    changeAt,
    editable: host.editable,
    filesUnder,
    followMove: host.followMove,
    getCurrentPath: host.getCurrentPath,
    ignoredPath,
    notify: (message) => {
      toaster.notify(message);
    },
    openFile: host.openFile,
    placeCaret: host.placeCaret,
    report: host.report,
    resync,
    rows: store,
    signal: host.signal,
    syncOpen: host.syncOpen,
    workspace: host.workspace,
  });

  // The upload flow mounts its own input and drop highlight, and registers its
  // drag listeners as it is built (see `./tree-uploads`).
  const uploads = createTreeUploads({
    aborted: host.aborted,
    changeAt,
    editable: host.editable,
    hasRow,
    notify: (message) => {
      toaster.notify(message);
    },
    overlay: host.treeEl.parentNode ?? host.treeEl,
    report: host.report,
    resync,
    signal: host.signal,
    treeEl: host.treeEl,
    workspace: host.workspace,
  });

  // Naming an add is pierre's own inline rename (the row itself becomes the
  // input); the naming flow only holds its name rules in front of the commit.
  const naming = createTreeNaming({
    changeAt,
    dropRow,
    editable: host.editable,
    hasRow,
    landAdd: flow.landAdd,
    onRenamed: flow.renamedRow,
    rowAdd: (row) => {
      store.add(row);
    },
    startRenaming: (path) =>
      tree?.startRenaming(path, { removeIfCanceled: true }) ?? false,
    toaster,
    treeReady: () => tree !== undefined,
  });
  // oxlint-disable-next-line eslint/prefer-destructuring -- assigning one cell, not unpacking a shape.
  pendingPath = naming.pendingPath;

  /** Tear the pane's menu down (idempotent: pierre's own close lands here
   * too, when its menu state settles). */
  const closeMenu = () => {
    menu?.close();
    menu = null;
  };

  /** One menu for both targets: the rows pierre reports and the pane's empty
   * space, parked at the click because the tree's own pane clips and scrolls. */
  const openMenu = (
    target: MenuTarget,
    point: { x: number; y: number },
    close: (options?: { restoreFocus?: boolean }) => void
  ) => {
    closeMenu();
    const { path } = target;
    const dir = menuDir(path);
    // The adds take focus themselves (pierre's inline input), so the menu
    // closes without handing it back to the tree.
    const newFile = () => {
      close({ restoreFocus: false });
      naming.startAdd(dir, false);
    };
    const newFolder = () => {
      close({ restoreFocus: false });
      naming.startAdd(dir, true);
    };
    const onUpload = () => {
      close({ restoreFocus: false });
      uploads.pick(dir);
    };
    if (path === null) {
      menu = openTreeMenu(
        newTreeMenu({ newFile, newFolder, onUpload }),
        point,
        close
      );
      return;
    }
    // A right-click inside a multi-selection acts on all of it; anywhere
    // else, on that row alone.
    const selected = tree?.getSelectedPaths() ?? [];
    const rows =
      selected.length > 1 && selected.includes(path) ? selected : [path];
    menu = openTreeMenu(
      newTreeMenu({
        deleteCount: rows.length,
        newFile,
        newFolder,
        onDelete: () => {
          close();
          void flow.deleteRows(rows);
        },
        // A rename names one row: with a multi-selection in play the menu
        // leaves it out (pierre's inline input edits a single row).
        onRename:
          rows.length === 1
            ? () => {
                close({ restoreFocus: false });
                tree?.startRenaming(path);
              }
            : undefined,
        onUpload,
      }),
      point,
      close
    );
  };

  /** Right-click below the rows: pierre opens its menu on rows only, so the
   * pane offers the same one for the tree's root there. A read-only checkout
   * has no row actions at all, so the pane says why instead of doing nothing. */
  const onTreeContextMenu = (event: MouseEvent) => {
    if (!host.editable()) {
      toaster.notify("This checkout is read-only.");
      return;
    }
    if (isTreeRow(event)) {
      return;
    }
    event.preventDefault();
    if (menu === null) {
      openMenu(
        { path: null },
        { x: event.clientX, y: event.clientY },
        closeMenu
      );
    }
  };

  /** Delete (and Cmd/Ctrl+Backspace, the mac shortcut) stages the selected
   * rows through the menu's own flow, confirmation and all. A rename input in
   * focus owns its keys, and a read-only ref has no rows to stage. */
  const onTreeKeyDown = (event: KeyboardEvent) => {
    const deleting =
      event.key === "Delete" ||
      (event.key === "Backspace" && (event.metaKey || event.ctrlKey));
    if (!deleting || !host.editable() || renameInput(event) !== null) {
      return;
    }
    const rows = tree?.getSelectedPaths() ?? [];
    if (rows.length === 0) {
      return;
    }
    event.preventDefault();
    void flow.deleteRows(rows);
  };

  // Naming an add is pierre's own inline rename (the row itself becomes the
  // input); the pane only has to hold its name rules in front of the commit,
  // open a menu where pierre has no row of its own, and take the OS file drops
  // pierre itself knows nothing about. Every listener rides the wiring's
  // signal: the pane element outlives a ref change (ilha adopts it), so a
  // wiring that does not abort would leave its handlers acting on a closed
  // workspace.
  host.treeEl.addEventListener("contextmenu", onTreeContextMenu, {
    signal: host.signal,
  });
  host.treeEl.addEventListener("focusout", naming.onNameBlur, {
    capture: true,
    signal: host.signal,
  });
  host.treeEl.addEventListener("keydown", naming.guardNameKey, {
    capture: true,
    signal: host.signal,
  });
  host.treeEl.addEventListener("keydown", onTreeKeyDown, {
    signal: host.signal,
  });

  /** Build the file tree from the checkout: one row per file and per empty
   * folder, one per path the rules exclude (which the markers paint dimmed),
   * with the commit's own markers. Returns the file to open first, if any. */
  const buildTree = (listing: CheckoutListing): string | undefined => {
    holdIgnored(listing);
    const paths = rowPaths(listing);
    held = new Set(paths);
    // Deep link wins when it names a real row; otherwise the Worker config is
    // the sensible default to open — and the tree highlights whichever file
    // lands open.
    const urlFile = host.file();
    const configFile = CONFIG_FILES.find((name) =>
      listing.files.includes(name)
    );
    const initial: string | undefined =
      urlFile !== "" && held.has(urlFile) ? urlFile : configFile;
    // Ancestor dirs of the initial file, so deep links land with
    // parents expanded (collapsed parents hide the selection and
    // block the focus scroll).
    const ancestors: string[] = [];
    if (initial) {
      const parts = initial.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        ancestors.push(parts.slice(0, i).join("/"));
      }
    }
    tree?.cleanUp();
    // A rebuild drops the old tree with whatever menu or placeholder row it
    // was showing: the rows come straight back from the fresh input.
    closeMenu();
    naming.clearPending();
    const { FileTree, preparePresortedFileTreeInput } = host.trees;
    const entries = [...markers(host.changes()), ...ignored];
    treeStatusKey = statusKey(entries);
    tree = new FileTree({
      composition: host.editable()
        ? {
            contextMenu: {
              enabled: true,
              onClose: closeMenu,
              onOpen: (item, context) => {
                openMenu(
                  { path: item.path },
                  context.anchorRect,
                  context.close
                );
              },
              triggerMode: "right-click",
            },
          }
        : undefined,
      // Top-level, like `renaming`: on a read-only ref there is no config at
      // all, so nothing is draggable.
      dragAndDrop: host.editable()
        ? {
            canDrop: flow.canDrop,
            onDropComplete: flow.landDrops,
            onDropError: (error) => {
              toaster.notify(error);
            },
          }
        : undefined,
      gitStatus: entries,
      initialExpandedPaths: ancestors,
      initialSelectedPaths: initial ? [initial] : undefined,
      onSelectionChange: (selected) => {
        if (selected[0]) {
          void host.openFile(selected[0]);
        }
      },
      preparedInput: preparePresortedFileTreeInput(
        sortTreePaths([...listing.files, ...listing.ignoredFiles])
      ),
      // Top-level, not under `composition`: see `FileTreeOptions`.
      renaming: host.editable()
        ? {
            // A row of the commit renames in place (a move in the pod); the
            // add placeholder renames too, and lands as the file it named.
            canRename: () => host.editable(),
            onError: naming.nameRefused,
            onRename: naming.finishAdd,
          }
        : undefined,
      search: true,
    });
    // The pane may hold the note painted while the checkout opened (see
    // `browser.tsx`): the rows replace it rather than stack under it.
    host.treeEl.textContent = "";
    tree.render({ fileTreeContainer: host.treeEl });
    // An empty folder is a row nothing implies — git keeps none, so the
    // checkout only has one because someone made it here: pierre is told about
    // it by name. An excluded folder is named for the same reason: nothing
    // under it was listed, so no row of its own implies it either.
    for (const dir of [...listing.dirs, ...listing.ignoredDirs]) {
      const row = `${dir}/`;
      if (!hasRow(row)) {
        tree.add(row);
      }
    }
    return initial;
  };

  /** Discard every change: the pod goes back to the browsed commit, the rows
   * follow it, and the pane lands on the file it was showing — or on the one
   * the browse opened with, when that file is gone. */
  const discardAllChanges = () => {
    if (!host.editable()) {
      return;
    }
    void (async () => {
      const wasOpen = host.getCurrentPath();
      try {
        await host.workspace().discardAll();
      } catch (error) {
        toaster.notify(errorMessage(error));
      }
      await resync();
      host.report();
      if (wasOpen !== null && hasRow(wasOpen)) {
        void host.openFile(wasOpen);
        return;
      }
      const wanted = host.file();
      if (wanted !== "" && hasRow(wanted)) {
        void host.openFile(wanted);
        return;
      }
      await host.syncOpen();
    })();
  };

  const cleanUp = () => {
    menu?.close();
    menu = null;
    toaster.host.remove();
    uploads.cleanUp();
    tree?.cleanUp();
  };

  return {
    buildTree,
    cleanUp,
    discard: flow.discardChange,
    discardAll: discardAllChanges,
    hasRow,
    notify: (message) => {
      toaster.notify(message);
    },
    restorePath: flow.restorePath,
    resync,
    syncStatus,
  };
};
