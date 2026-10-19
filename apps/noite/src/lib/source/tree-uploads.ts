//! The source tree's upload flow: the hidden file input the context menu's
//! "Upload files…" clicks, the OS-file drop target and its highlight, and the
//! write of every read into the folder it was dropped on. A read that is text
//! becomes a file's text, anything else its bytes — the pod stores both — and
//! the rows and markers follow from the derive the writes trigger. The rows,
//! the menu and the naming belong to `./tree`; this module reaches them through
//! `host`.

import { base64ToBytes } from "../bytes";
import { errorMessage } from "../errors";
import { confirmDialog } from "../ui/confirm";
import { menuDir } from "./tree-menu";
import {
  checkLimits,
  readDroppedItems,
  readPickedFiles,
  UPLOAD_LIMITS,
} from "./uploads";
import type { UploadRead } from "./uploads";
import type { Workspace, WorkspaceChange } from "./workspace/types";

/** What the upload flow needs from the tree wiring. */
export interface TreeUploadsHost {
  aborted: () => boolean;
  /** The change the workspace derived for a path, when it has one. */
  changeAt: (path: string) => WorkspaceChange | undefined;
  editable: () => boolean;
  /** Whether pierre still holds a path (its store, not the visible rows). */
  hasRow: (path: string) => boolean;
  /** The pane's toast corner, for read errors and cap breaches. */
  notify: (message: string) => void;
  /** The element the picker and the drop highlight mount in: the tree's pane
   * (a shadow-root element, so ilha's light-DOM morph never reaches it, and
   * outside its body, which a paint may wipe — see the input's own note
   * below). */
  overlay: ParentNode;
  report: () => void;
  /** Derive again and put the rows in step with the pod (see `./tree`). */
  resync: () => Promise<void>;
  signal: AbortSignal;
  treeEl: HTMLElement;
  /** The checkout an upload writes into, as of now (see `./tree`). */
  workspace: () => Workspace;
}

/** The upload flow's surface for the tree wiring. */
export interface TreeUploads {
  cleanUp: () => void;
  /** Click the picker inside the menu item's own user gesture. */
  pick: (dir: string) => void;
}

/** Whether a drag carries OS files. Pierre's own row drags ride on
 * `text/plain` and never on `Files`, which is what tells the two apart — an
 * internal move must keep going to pierre's own handlers. */
const isFileDrag = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes("Files") ?? false;

/** The deepest element at a viewport point: `elementFromPoint` stops at the
 * first shadow host on the way down (both panes render in a shadow root), so
 * every shadow root is probed in turn. */
const deepestElementAt = (x: number, y: number): Element | null => {
  let element = document.elementFromPoint(x, y);

  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);

    if (inner === null || inner === element) {
      break;
    }

    element = inner;
  }

  return element;
};

/** The folder a drop at a viewport point writes into: a folder row takes the
 * files inside it, a file row its parent folder, and empty space the root —
 * the convention the context menu already uses (`menuDir`). */
const dropDirAt = (x: number, y: number): string => {
  const row = deepestElementAt(x, y)?.closest<HTMLElement>(
    '[data-type="item"]'
  );

  return menuDir(row?.dataset.itemPath ?? null);
};

export const createTreeUploads = (host: TreeUploadsHost): TreeUploads => {
  /** Weigh one read set, then write it into the folder it was dropped on (or
   * picked for): a text file lands as its text, anything else byte-for-byte. A
   * path the tree already holds — or one a staged deletion emptied — is asked
   * about first. A read the browser could not make is reported and skipped; a
   * set that breaks the commit's caps is refused whole, with nothing written. */
  const applyUploads = async (
    reads: readonly UploadRead[],
    dir: string
  ): Promise<void> => {
    const breach = checkLimits(reads, UPLOAD_LIMITS);

    if (breach !== null) {
      host.notify(breach);

      return;
    }

    // The read's own path is relative to the target; the folder becomes its
    // prefix (the root contributes none).
    const prefix = dir === "" ? "" : `${dir}/`;
    /** The writes the confirms let through: each lands as it is made, and the
     * re-list waits for all of them. */
    const writes: Promise<void>[] = [];

    for (const read of reads) {
      if (read.kind === "error") {
        host.notify(read.reason);
        continue;
      }

      const path = `${prefix}${read.path}`;

      if (host.hasRow(path) || host.changeAt(path)?.kind === "deleted") {
        // One dialog at a time: two stacked confirms would make no sense, so
        // the wait here is deliberately sequential.
        // oxlint-disable-next-line no-await-in-loop -- the confirms queue, they do not run at once
        const replace = await confirmDialog({
          confirmLabel: "Replace",
          message: "The file is already in the tree.",
          signal: host.signal,
          title: `Replace ${path}?`,
        });

        if (!replace || host.aborted()) {
          continue;
        }
      }

      // A staged deletion loses to the write: the file is coming back.
      writes.push(
        (async () => {
          try {
            await (read.kind === "text"
              ? host.workspace().writeText(path, read.text)
              : host.workspace().writeBytes(path, base64ToBytes(read.base64)));
          } catch (error) {
            host.notify(errorMessage(error));
          }
        })()
      );
    }

    await Promise.all(writes);
    await host.resync();
    host.report();
  };

  /** The folder the picker's files go into (the menu's own target), and the
   * hidden input they are picked through — one per wiring, parked in the pane
   * (the host `overlay` names) rather than in the body pierre's rows live in:
   * pierre renders those in a shadow root of its own, so the body's light DOM
   * never shows, while a shadow root is also what ilha's morph cannot reach
   * into. */
  let pickDir = "";
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";
  input.dataset.fileUpload = "true";
  input.addEventListener("change", () => {
    // Snapshotted before the value is cleared: the same file must be pickable
    // twice in a row.
    const files = [...(input.files ?? [])];
    input.value = "";

    if (files.length === 0) {
      return;
    }

    void (async () => {
      const reads = await readPickedFiles(files);
      await applyUploads(reads, pickDir);
    })();
  });

  /** The drop highlight: the pane's own rectangle, click-through (so the
   * pointer still resolves to the row under it), in the accent the tree's
   * other highlights wear — `--color-primary`, the trees accent the host
   * overrides. */
  const dropHighlight = document.createElement("div");
  dropHighlight.dataset.treeDropHighlight = "true";
  dropHighlight.style.display = "none";
  dropHighlight.style.pointerEvents = "none";
  dropHighlight.style.position = "fixed";
  dropHighlight.style.zIndex = "10";
  dropHighlight.style.outline = "2px solid var(--color-primary)";
  dropHighlight.style.outlineOffset = "-2px";
  host.overlay.append(input, dropHighlight);

  /** Pin the highlight to the pane (it is mounted beside it, see above). */
  const showDropHighlight = () => {
    const rect = host.treeEl.getBoundingClientRect();
    dropHighlight.style.left = `${rect.left}px`;
    dropHighlight.style.top = `${rect.top}px`;
    dropHighlight.style.width = `${rect.width}px`;
    dropHighlight.style.height = `${rect.height}px`;
    dropHighlight.style.display = "";
  };

  const hideDropHighlight = () => {
    dropHighlight.style.display = "none";
  };

  /** The menu's "Upload files…": the input is clicked inside the menu item's
   * own user gesture, which is what the picker requires. */
  const pick = (dir: string) => {
    pickDir = dir;
    input.click();
  };

  const onTreeDragOver = (event: DragEvent) => {
    if (!host.editable() || !isFileDrag(event)) {
      return;
    }

    // The browser only delivers a drop when a dragover was canceled.
    event.preventDefault();

    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "copy";
    }

    showDropHighlight();
  };

  /** `dragleave` also fires for every row the pointer crosses, and the rows
   * hide behind a shadow root (so `relatedTarget` tells nothing): the pane's
   * own rectangle is what decides whether the drag really left it. */
  const onTreeDragLeave = (event: DragEvent) => {
    const rect = host.treeEl.getBoundingClientRect();

    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;

    if (!inside) {
      hideDropHighlight();
    }
  };

  /** An OS drop: the items are read synchronously (the list empties as the
   * handler returns) and land in the folder under the pointer. */
  const onTreeDrop = (event: DragEvent) => {
    if (!host.editable() || !isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    hideDropHighlight();
    const items = event.dataTransfer?.items;

    if (items === undefined) {
      return;
    }

    const dir = dropDirAt(event.clientX, event.clientY);
    void (async () => {
      const reads = await readDroppedItems(items);
      await applyUploads(reads, dir);
    })();
  };

  // The pane element outlives a ref change (ilha adopts it), so these ride the
  // wiring's signal: a stale wiring must not answer the next ref's drops.
  host.treeEl.addEventListener("dragleave", onTreeDragLeave, {
    signal: host.signal,
  });
  host.treeEl.addEventListener("dragover", onTreeDragOver, {
    signal: host.signal,
  });
  host.treeEl.addEventListener("drop", onTreeDrop, { signal: host.signal });

  const cleanUp = () => {
    input.remove();
    dropHighlight.remove();
  };

  return { cleanUp, pick };
};
