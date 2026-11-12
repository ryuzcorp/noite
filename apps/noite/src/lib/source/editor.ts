//! The code pane: the `@pierre/diffs` file view, the edit session attached to
//! it, and the one blob read that fills it. There is no file system behind it —
//! opening a path reads that file from the runner, a keystroke hands the text
//! to the page's session (`./session`), and nothing is written anywhere until
//! the Changes form commits.
//!
//! ## What the pane shows
//!
//! | the blob | the pane |
//! | --- | --- |
//! | text, editable checkout | a text file, the editor attached |
//! | text, read-only checkout | a text file, no edit session |
//! | binary | a placeholder note, no edit session |
//! | past `TEXT_MAX_BYTES` | a placeholder note, no edit session |
//! | a path the commit dropped | whatever is staged at it, or "not found" |

import { errorMessage } from "../errors";
import type { RunnerBlob } from "../runner";
import type { SearchParam } from "../search-param";
import { curatedLang } from "../shiki-langs";
import { THEME } from "./pane";
import {
  newPaneMachine,
  paintedOf,
  PaneEvents,
  panePath,
  PaneViews,
  stepPane,
} from "./pane-view";
import type {
  PaneEvent,
  PaneMachine,
  PanePainted,
  ReadTicket,
} from "./pane-view";
import type { DiffsModule, EditModule, PierreFileView } from "./pierre";
import type { ChangeKind } from "./session";
import { TEXT_MAX_BYTES } from "./uploads";

/** What the pane shows for a file it will not render as text. */
const BINARY_PLACEHOLDER = "(binary file — preview not available)";
const OVERSIZE_PLACEHOLDER = "(file exceeds 256 KB — preview not available)";

/** What the pane says for a checkout that holds no files at all. */
const NO_FILES_NOTE = "This repository has no files yet";

/** The letter the header paints the open file's change as, matching the tree's
 * own lane so the two panes never disagree. */
const CHANGE_LETTER: Record<ChangeKind, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  moved: "R",
};

/** What the editor pane needs from the browser. */
export interface EditorHost {
  aborted: () => boolean;
  /** The change at the open path, for the header chip (null when none). */
  changeAt: (path: string) => ChangeKind | null;
  /** The pane's body: what pierre mounts into, and the one container a paint
   * wipes. */
  codeEl: HTMLElement;
  diffs: DiffsModule;
  edit: EditModule;
  /** Whether the browsed checkout may be edited at all (see `ReadOnlyRef`). */
  editable: () => boolean;
  /** The text this page already holds for `path` (a buffer), or null. */
  held: (path: string) => string | null;
  /** A keystroke: the text of the open file, to keep in the session. */
  onEdit: (path: string, text: string) => void;
  /** `?file=`: the open file is deep-linkable. */
  file: SearchParam<string>;
  /** Read one blob at the browsed ref. Throws the runner's refusal. */
  read: (path: string) => Promise<RunnerBlob>;
}

/** The editor pane's surface for the browser and the tree wiring. */
export interface EditorPane {
  /** The pierre teardown, called last, after the tree's own cleanup. */
  cleanUp: () => void;
  /** The path the pane holds, or null. */
  current: () => string | null;
  /** A ref switch dropped the checkout under the pane: forget the file. */
  drop: () => void;
  /** Paint `path`; answers whether the pane shows a file at all. */
  open: (path: string) => Promise<boolean>;
  /** Re-read the open file (a commit moved its base, or the page reset). */
  reload: () => Promise<boolean>;
  /** The checkout opened with no files: paint the one note this pane has for
   * it (a state of the pane machine, see `./pane-view`). */
  empty: () => void;
  /** Repaint the header chip from the session's changes. */
  syncStatus: () => void;
}

export const createEditorPane = (host: EditorHost): EditorPane => {
  const { codeEl, diffs } = host;
  let machine: PaneMachine = newPaneMachine();
  let disposeEdit: (() => void) | undefined;

  // The chip rides in pierre's header as light DOM (the header is a shadow
  // root with a slot for it), so it survives every repaint.
  const statusChip = document.createElement("span");
  statusChip.className = "noite-src-change";
  statusChip.slot = "header-filename-suffix";
  statusChip.hidden = true;

  const paintStatus = (path: string | null): void => {
    const kind = path === null ? null : host.changeAt(path);

    if (kind === null) {
      statusChip.hidden = true;

      return;
    }

    statusChip.dataset.changeKind = kind;
    statusChip.textContent = CHANGE_LETTER[kind];
    statusChip.hidden = false;
  };

  const attachStatus = (container: Element | null): void => {
    if (container !== null && statusChip.parentNode !== container) {
      container.append(statusChip);
    }
  };

  const editor = new host.edit.Editor("file");

  const fileView: PierreFileView = new diffs.File({
    onEditChange: () => {
      const shown = paintedOf(machine.view);

      if (shown === null || !shown.editable) {
        return;
      }

      host.onEdit(shown.path, editor.getText());
      paintStatus(shown.path);
    },
    // The header rides above the file and stays there while the pane scrolls:
    // the browser's own scroll container is the code host (see `browser.tsx`),
    // and pierre marks the header sticky (its `data-sticky` rule).
    overflow: "scroll",
    stickyHeader: true,
    theme: THEME,
  });

  /** The text a paint shows for one blob. */
  const painted = (path: string, blob: RunnerBlob): PanePainted => {
    const live = host.held(path);

    if (blob.binary) {
      return {
        editable: false,
        path,
        placeholder: BINARY_PLACEHOLDER,
        text: "",
      };
    }

    if (blob.truncated || blob.size > TEXT_MAX_BYTES) {
      return {
        editable: false,
        path,
        placeholder: OVERSIZE_PLACEHOLDER,
        text: "",
      };
    }

    return {
      editable: host.editable(),
      path,
      placeholder: null,
      text: live ?? blob.text,
    };
  };

  /** Strip everything the last paint left except pierre's own container (a
   * repaint of the same view renders into it, and never appends it again). */
  const clearBody = (): void => {
    let node = codeEl.firstChild;

    while (node !== null) {
      const next = node.nextSibling;

      if (node.nodeName.toLowerCase() !== "diffs-container") {
        node.remove();
      }

      node = next;
    }
  };

  const paint = (show: PanePainted): void => {
    disposeEdit?.();
    disposeEdit = undefined;

    if (show.placeholder !== null) {
      clearBody();
      codeEl.textContent = show.placeholder;
      paintStatus(show.path);

      return;
    }

    clearBody();
    fileView.render({
      containerWrapper: codeEl,
      file: {
        contents: show.text,
        lang: curatedLang(show.path, diffs.getFiletypeFromFileName),
        name: show.path,
      },
    });
    attachStatus(codeEl.querySelector("diffs-container"));
    paintStatus(show.path);

    if (show.editable) {
      disposeEdit = editor.edit(fileView);
    }
  };

  /** Apply one event to the machine and keep its new state. */
  const advance = (event: PaneEvent) => {
    const decision = stepPane(machine, event);
    ({ machine } = decision);

    return decision;
  };

  /** One standing note in the pane, with no file under it. */
  const paintNote = (message: string): void => {
    clearBody();
    codeEl.textContent = message;
    statusChip.hidden = true;
  };

  const empty = (): void => {
    disposeEdit?.();
    disposeEdit = undefined;
    advance(PaneEvents.Emptied());
    paintNote(NO_FILES_NOTE);
  };

  const read = async (ticket: ReadTicket): Promise<boolean> => {
    let blob: RunnerBlob;

    try {
      blob = await host.read(ticket.path);
    } catch (error) {
      if (!host.aborted()) {
        advance(
          PaneEvents.Failed({
            message: errorMessage(error),
            ticket,
          })
        );
        paintNote(errorMessage(error));
      }

      return false;
    }

    if (host.aborted()) {
      return false;
    }

    const show = painted(ticket.path, blob);
    const resolved = advance(PaneEvents.Resolved({ painted: show, ticket }));

    if (resolved.refused) {
      // A newer read was started while this one was in flight.
      return false;
    }

    if (host.file() !== ticket.path) {
      host.file.set(ticket.path);
    }

    paint(show);

    return true;
  };

  const open = async (path: string): Promise<boolean> => {
    if (host.aborted() || path === "") {
      return false;
    }

    const decision = advance(PaneEvents.Requested({ path }));

    if (decision.read === null) {
      return false;
    }

    const shown = paintedOf(machine.view);

    if (shown !== null && shown.placeholder === null && shown.path !== path) {
      // The last paint stays on screen until the read lands: one note first,
      // so the old file is not edited under a path that is about to change.
      disposeEdit?.();
      disposeEdit = undefined;
    }

    return await read(decision.read);
  };

  return {
    cleanUp: () => {
      disposeEdit?.();
      disposeEdit = undefined;
      fileView.cleanUp();
      editor.cleanUp();
    },
    current: () => panePath(machine.view),
    drop: () => {
      disposeEdit?.();
      disposeEdit = undefined;
      // A new sequence: any read still in flight resolves against a machine
      // that is no longer waiting for it, and is refused.
      machine = { seq: machine.seq + 1, view: PaneViews.Closed() };
      statusChip.hidden = true;
    },
    empty,
    open,
    reload: async () => {
      const path = panePath(machine.view);

      if (path === null) {
        return false;
      }

      return await open(path);
    },
    syncStatus: () => {
      paintStatus(panePath(machine.view));
    },
  };
};
