//! The source tree wiring: the `@pierre/trees` instance the pane mounts, its
//! options and composition (context menu, inline renaming, drag and drop), and
//! the flows it composes. The rows are the browsed commit's files plus what
//! the page's session holds — nothing is read from or written to a filesystem,
//! because there is none: a New File is a buffer, a move is the commit's
//! `moves` list, and a delete is a staged deletion. The markers come from the
//! same session, so the tree and the Changes panel cannot disagree.

/* oxlint-disable eslint/no-use-before-define -- the tree's flows are mutually
   recursive by nature: `build` wires the pierre callbacks that call the flows,
   and every flow rebuilds the rows after a structural change. Hoisting one side
   would only move the cycle. */
import { errorMessage } from "../errors";
import type { SearchParam } from "../search-param";
import { confirmDialog } from "../ui/confirm";
import {
  clearNaming,
  finishNaming,
  newNamingMachine,
  refuseNaming,
  settleNaming,
  startNaming,
} from "./naming-state";
import type { NamingMachine, PendingAdd } from "./naming-state";
import type {
  Tree,
  TreeDropContext,
  TreeGitStatus,
  TreeRenameEvent,
  TreeStatusEntry,
  TreesModule,
} from "./pierre";
import type { ChangeKind, SourceChange, Upload } from "./session";
import { byPath } from "./session";
import {
  isTreeRow,
  menuDir,
  newToaster,
  newTreeMenu,
  openTreeMenu,
  parentDir,
  renameInput,
  sortTreePaths,
  withoutSlash,
} from "./tree-menu";
import type { Toaster, TreeMenu } from "./tree-menu";
import {
  checkLimits,
  readDroppedItems,
  readPickedFiles,
  UPLOAD_LIMITS,
} from "./uploads";
import type { UploadRead } from "./uploads";

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
  /** The change the session holds at `path`, when it has one. */
  changeAt: (path: string) => SourceChange | undefined;
  /** Every file the tree shows (the session's rows), in path order. */
  rows: () => readonly string[];
  /** Whether the browsed checkout may be edited. */
  editable: () => boolean;
  /** `?file=`: the open file is deep-linkable. */
  file: SearchParam<string>;
  /** The pane's open, so a selection shows the file. */
  openFile: (path: string) => Promise<boolean>;
  notify: (message: string) => void;
  /** Add a text file to the session; the reason when it is refused. */
  addText: (path: string, text: string) => string;
  /** Add an uploaded file to the session; the reason when it is refused. */
  addUpload: (path: string, upload: Upload) => string;
  /** Stage `path`'s deletion (an added file is simply forgotten). */
  removePath: (path: string) => void;
  /** Rename in the session; the reason when it is refused. */
  movePath: (from: string, to: string) => string;
  signal: AbortSignal;
  treeEl: HTMLElement;
  trees: TreesModule;
}

/** The tree wiring's surface for the browser. */
export interface TreeWiring {
  /** Build the rows: answers the file to open first, if any. */
  build: () => string | undefined;
  cleanUp: () => void;
  /** Repaint the markers from the session (a keystroke changes none of the
   * rows, only their status). */
  syncStatus: () => void;
}

/** The markers as a memo key: an unchanged set never repaints the tree. */
const statusKey = (entries: readonly TreeStatusEntry[]): string =>
  entries.map((entry) => `${entry.path}\u0000${entry.status}`).join("\n");

/** A folder rename carries every row under it. */
const under = (rows: readonly string[], dir: string): string[] =>
  rows.filter((path) => path.startsWith(`${dir}/`));

/** The path a row stands for: pierre hands folder rows with a trailing slash,
 * and the session speaks bare paths. */
const rowPath = (path: string): string => withoutSlash(path);

/** The folder rows of a path, so a deep link opens with its parents shown. */
const ancestors = (path: string): string[] => {
  const parts = path.split("/");
  const out: string[] = [];

  for (let i = 1; i < parts.length; i += 1) {
    out.push(parts.slice(0, i).join("/"));
  }

  return out;
};

/** Whether a drag carries files from outside the page (an OS drop). */
const onDragOver = (event: DragEvent): void => {
  if (event.dataTransfer === null) {
    return;
  }

  if ([...event.dataTransfer.types].includes("Files")) {
    event.preventDefault();
  }
};

export const createTreeWiring = (host: TreeHost): TreeWiring => {
  let tree: Tree | undefined;
  /** The row paths pierre holds, as one set: pierre's store cannot be
   * enumerated, so the wiring remembers what it put there. */
  let held = new Set<string>();
  let treeStatusKey = "";
  let menu: TreeMenu | null = null;
  let naming: NamingMachine = newNamingMachine();
  const toaster: Toaster = newToaster();

  // One hidden picker for the menu's upload action; its change handler is
  // registered with the rest of the listeners at the bottom.
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  input.dataset.sourceUpload = "true";

  const notify = (message: string): void => {
    toaster.notify(message);
  };

  const markers = (): TreeStatusEntry[] =>
    host.rows().flatMap((path) => {
      const change = host.changeAt(path);

      return change === undefined
        ? []
        : [{ path, status: STATUS[change.kind] }];
    });

  const syncStatus = (): void => {
    const entries = markers();
    const key = statusKey(entries);

    if (key === treeStatusKey) {
      return;
    }

    treeStatusKey = key;
    tree?.setGitStatus(entries);
  };

  /** The file to open when a browse names none: the deep link, else the
   * Worker config, else nothing. */
  const firstFile = (): string | undefined => {
    const wanted = host.file();

    if (wanted !== "" && held.has(wanted)) {
      return wanted;
    }

    return CONFIG_FILES.find((name) => held.has(name));
  };

  const closeMenu = (): void => {
    menu?.close();
    menu = null;
  };

  /** One rename in the session; the refusal is the user's to read. */
  const landMove = (from: string, to: string): void => {
    const refusal = host.movePath(from, to);

    if (refusal !== "") {
      notify(refusal);
    }
  };

  /** Rebuild the rows from the session: after a ref switch, a move, a delete
   * or an add, the listing is the truth. Rebuilding rather than patching keeps
   * pierre's store and the session from drifting apart — the two used to be
   * separate copies of the tree. */
  const build = (): string | undefined => {
    const rows = [...host.rows()].toSorted(byPath);
    held = new Set(rows);
    const initial = firstFile();
    tree?.cleanUp();
    closeMenu();
    const { FileTree, preparePresortedFileTreeInput } = host.trees;
    const entries = markers();
    treeStatusKey = statusKey(entries);
    tree = new FileTree({
      composition: host.editable()
        ? {
            contextMenu: {
              enabled: true,
              onClose: closeMenu,
              onOpen: (item, context) => {
                openMenu(rowPath(item.path), context.anchorRect, context.close);
              },
              triggerMode: "right-click",
            },
          }
        : undefined,
      dragAndDrop: host.editable()
        ? {
            canDrop: (drop: TreeDropContext) =>
              host.editable() && drop.draggedPaths.length > 0,
            onDropComplete: (drop) => {
              for (const dragged of drop.draggedPaths) {
                const from = rowPath(dragged);
                const name = from.slice(from.lastIndexOf("/") + 1);

                const to =
                  drop.target.kind === "root" ||
                  drop.target.directoryPath === null
                    ? name
                    : `${drop.target.directoryPath}${name}`;

                landMove(from, to);
              }

              build();
            },
            onDropError: notify,
          }
        : undefined,
      gitStatus: entries,
      initialExpandedPaths: initial === undefined ? [] : ancestors(initial),
      initialSelectedPaths: initial === undefined ? undefined : [initial],
      onSelectionChange: (selected) => {
        const [first] = selected;

        if (first !== undefined && !first.endsWith("/")) {
          void host.openFile(rowPath(first));
        }
      },
      preparedInput: preparePresortedFileTreeInput(sortTreePaths(rows)),
      // Top-level, not under `composition`: see `FileTreeOptions`.
      renaming: host.editable()
        ? {
            canRename: () => host.editable(),
            onError: nameRefused,
            onRename: finishAdd,
          }
        : undefined,
      search: true,
    });
    // The pane may hold a note from before the rows arrived: the tree replaces
    // it rather than stacking under it.
    host.treeEl.textContent = "";
    tree.render({ fileTreeContainer: host.treeEl });

    return initial;
  };

  /** Rename a row pierre already moved: a folder carries everything under it,
   * and the row itself is one file or nothing. */
  const landRename = (from: string, to: string, isFolder: boolean): void => {
    if (!isFolder) {
      landMove(from, to);
      build();

      return;
    }

    for (const path of under([...held], from)) {
      landMove(path, `${to}${path.slice(from.length)}`);
    }

    build();
  };

  /** A name no path may carry, or one a staged change still claims. */
  const nameError = (leaf: string, path: string): string | null => {
    if (leaf === "" || leaf === "." || leaf === "..") {
      return `"${leaf}" is not a usable name.`;
    }

    const change = host.changeAt(path);

    return change === undefined ? null : `"${leaf}" already exists.`;
  };

  /** A free leaf in `dir` for the row the inline input names. */
  const uniqueLeaf = (dir: string, stem: string): string => {
    for (let n = 1; ; n += 1) {
      const leaf = n === 1 ? stem : `${stem}-${n}`;

      if (host.changeAt(`${dir}${leaf}`) === undefined) {
        return leaf;
      }
    }
  };

  /** The placeholder a New File parked, landed as the file it named. */
  const landAdd = (add: PendingAdd): void => {
    const refusal = host.addText(add.path, "");

    if (refusal !== "") {
      notify(refusal);
      build();

      return;
    }

    build();
    void host.openFile(add.path);
  };

  /** pierre's inline input landed on a name: the add becomes the file it
   * names, or the placeholder is taken back out. */
  const finishAdd = (event: TreeRenameEvent): void => {
    const dest = rowPath(event.destinationPath);
    const pending = naming.state._tag === "Naming" ? naming.state.add : null;

    if (pending !== null && event.sourcePath === pending.path) {
      const error = nameError(dest.slice(dest.lastIndexOf("/") + 1), dest);

      if (error !== null) {
        naming = clearNaming(naming);
        queueMicrotask(() => {
          build();
        });
        notify(error);

        return;
      }
    }

    const decision = finishNaming(naming, {
      destinationPath: dest,
      isFolder: event.isFolder,
      sourcePath: rowPath(event.sourcePath),
    });

    naming = decision.machine;

    if (decision.land !== null) {
      landAdd(decision.land);

      return;
    }

    if (decision.rename !== null) {
      landRename(
        rowPath(decision.rename.sourcePath),
        rowPath(decision.rename.destinationPath),
        event.isFolder
      );
    }
  };

  /** pierre refused a name (empty, a "/" in it, a path its store holds): the
   * input closes but the placeholder stays, so it is taken back out here. */
  const nameRefused = (error: string): void => {
    const decision = refuseNaming(naming, error);
    naming = decision.machine;

    if (decision.refused) {
      return;
    }

    queueMicrotask(() => {
      build();
    });

    if (decision.notify !== null) {
      notify(decision.notify);
    }
  };

  /** An untouched name is no rename at all: the placeholder is settled by the
   * blur that closes the input. One microtask out, because pierre finishes its
   * own state after its callbacks return. */
  const settleAdd = (add: PendingAdd): void => {
    queueMicrotask(() => {
      const decision = settleNaming(naming, add, held.has(add.path));
      naming = decision.machine;

      if (decision.land !== null) {
        landAdd(decision.land);
      }
    });
  };

  /** New File: a placeholder row goes in, pierre turns it into its inline
   * input, and the name it lands on becomes the file. A second pick while one
   * is being named is refused — it would orphan the first placeholder. */
  const startAdd = (dir: string): void => {
    if (!host.editable() || tree === undefined) {
      return;
    }

    const prefix = dir === "" ? "" : `${dir}/`;
    const path = `${prefix}${uniqueLeaf(prefix, "untitled")}`;
    const started = startNaming(naming, { isFolder: false, path });

    if (!started.accepted) {
      return;
    }

    naming = started.machine;

    try {
      tree.add(path);
      held.add(path);
    } catch (error) {
      notify(errorMessage(error));

      return;
    }

    if (!tree.startRenaming(path, { removeIfCanceled: true })) {
      naming = clearNaming(naming);
      build();
      notify("This tree cannot be changed.");
    }
  };

  /** New name rules in front of pierre's commit: Enter would take the name and
   * move the row, so a refused one is stopped while the input still has it. */
  const guardNameKey = (event: KeyboardEvent): void => {
    const add = naming.state._tag === "Naming" ? naming.state.add : null;

    if (event.key !== "Enter" || add === null || renameInput(event) === null) {
      return;
    }

    const field = renameInput(event);

    if (field === null) {
      return;
    }

    const name = field.value.trim();
    const dir = parentDir(add.path);
    const path = dir === "" ? name : `${dir}/${name}`;
    const error = nameError(name, path);

    if (error !== null) {
      event.preventDefault();
      event.stopPropagation();
      notify(error);

      return;
    }

    if (path === add.path) {
      settleAdd(add);
    }
  };

  const onNameBlur = (event: FocusEvent): void => {
    const add = naming.state._tag === "Naming" ? naming.state.add : null;

    if (add === null || renameInput(event) === null) {
      return;
    }

    settleAdd(add);
  };

  /** Stage the deletion of every selected row, one confirmation for all of
   * them. A folder row takes its files with it. */
  const deleteRows = async (paths: readonly string[]): Promise<void> => {
    if (!host.editable() || paths.length === 0) {
      return;
    }

    const targets = paths.flatMap((path) => {
      const bare = rowPath(path);

      return path.endsWith("/") ? under([...held], bare) : [bare];
    });

    const unique = [...new Set(targets)];

    const committed = unique.filter(
      (path) => host.changeAt(path)?.kind !== "added"
    ).length;

    const [only] = paths;

    const ok = await confirmDialog({
      confirmLabel: "Delete",
      message:
        committed === 0
          ? "These files leave the tree."
          : `Pushing removes ${committed} ${committed === 1 ? "file" : "files"} from the repository.`,
      signal: host.signal,
      title:
        paths.length === 1 && only !== undefined
          ? `Delete ${rowPath(only)}?`
          : `Delete ${paths.length} items?`,
    });

    if (ok !== "confirm" || host.aborted()) {
      return;
    }

    for (const path of unique) {
      host.removePath(path);
    }

    build();
  };

  /** One menu for both targets: the rows pierre reports and the pane's empty
   * space, parked at the click because the tree's own pane clips and scrolls. */
  const openMenu = (
    path: string | null,
    point: { x: number; y: number },
    close: (options?: { restoreFocus?: boolean }) => void
  ): void => {
    closeMenu();
    const dir = menuDir(path);

    const newFile = (): void => {
      close({ restoreFocus: false });
      startAdd(dir);
    };

    const pickUpload = (): void => {
      close({ restoreFocus: false });
      input.click();
    };

    if (path === null) {
      menu = openTreeMenu(
        newTreeMenu({ newFile, onUpload: pickUpload }),
        point,
        closeMenu
      );

      return;
    }

    const selected = tree?.getSelectedPaths() ?? [];

    const rows =
      selected.length > 1 && selected.includes(path) ? [...selected] : [path];

    menu = openTreeMenu(
      newTreeMenu({
        deleteCount: rows.length,
        newFile,
        onDelete: () => {
          close();
          void deleteRows(rows);
        },
        onRename:
          rows.length === 1
            ? () => {
                close({ restoreFocus: false });
                tree?.startRenaming(path);
              }
            : undefined,
        onUpload: pickUpload,
      }),
      point,
      closeMenu
    );
  };

  /** Right-click below the rows: pierre opens its menu on rows only, so the
   * pane offers the same one for the tree's root there. The listener sits on
   * the document in the capture phase: pierre's own handler runs inside its
   * shadow root and can consume the event before it bubbles, and a right-click
   * that opens no menu at all is worse than a duplicate one — the row case is
   * detected from the composed path and left to pierre. */
  const onTreeContextMenu = (event: MouseEvent): void => {
    if (
      !host.treeEl.isConnected ||
      !event.composedPath().includes(host.treeEl)
    ) {
      return;
    }

    if (!host.editable()) {
      notify("This checkout is read-only.");

      return;
    }

    if (isTreeRow(event)) {
      return;
    }

    event.preventDefault();

    if (menu === null) {
      openMenu(null, { x: event.clientX, y: event.clientY }, closeMenu);
    }
  };

  /** Delete (and Cmd/Ctrl+Backspace, the mac shortcut) stages the selected
   * rows through the menu's own flow, confirmation and all. A rename input in
   * focus owns its keys. */
  const onTreeKeyDown = (event: KeyboardEvent): void => {
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
    void deleteRows(rows);
  };

  // The upload flow: one hidden picker for the menu (created above), and OS
  // file drops on the pane (pierre knows nothing of files dragged in from the
  // desktop).
  /** Land one upload read: text files are buffers, everything else bytes. */
  const landReads = (reads: readonly UploadRead[]): void => {
    if (reads.length === 0) {
      return;
    }

    const refusal = checkLimits(reads, UPLOAD_LIMITS);

    if (refusal !== null) {
      notify(refusal);

      return;
    }

    for (const read of reads) {
      if (read.kind === "error") {
        notify(`${read.path}: ${read.reason}`);

        continue;
      }

      const landed =
        read.kind === "text"
          ? host.addText(read.path, read.text)
          : host.addUpload(read.path, {
              bytes: read.bytes,
              content: read.base64,
            });

      if (landed !== "") {
        notify(landed);
      }
    }

    build();
  };

  const onPicked = (): void => {
    // Snapshot the list before clearing the input: resetting `value` empties
    // the live `FileList` this `input` handed out.
    const picked = [...(input.files ?? [])];
    input.value = "";

    if (picked.length === 0) {
      return;
    }

    void (async () => {
      landReads(await readPickedFiles(picked));
    })();
  };

  const onDrop = (event: DragEvent): void => {
    if (!host.editable() || event.dataTransfer === null) {
      return;
    }

    const hasFiles = [...event.dataTransfer.types].includes("Files");

    if (!hasFiles) {
      return;
    }

    event.preventDefault();
    const { items } = event.dataTransfer;

    if (items.length === 0) {
      return;
    }

    void (async () => {
      landReads(await readDroppedItems(items));
    })();
  };

  document.body.append(input);
  input.addEventListener("change", onPicked, { signal: host.signal });
  document.addEventListener("contextmenu", onTreeContextMenu, {
    capture: true,
    signal: host.signal,
  });
  host.treeEl.addEventListener("focusout", onNameBlur, {
    capture: true,
    signal: host.signal,
  });
  host.treeEl.addEventListener("keydown", guardNameKey, {
    capture: true,
    signal: host.signal,
  });
  host.treeEl.addEventListener("keydown", onTreeKeyDown, {
    signal: host.signal,
  });
  host.treeEl.addEventListener("dragover", onDragOver, { signal: host.signal });
  host.treeEl.addEventListener("drop", onDrop, { signal: host.signal });

  return {
    build,
    cleanUp: () => {
      closeMenu();
      toaster.host.remove();
      input.remove();
      tree?.cleanUp();
    },
    syncStatus,
  };
};
