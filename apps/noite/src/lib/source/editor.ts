//! The source pane's editor wiring: the `@pierre/diffs` File view and its
//! editor, the live text of every open path, and the file-open flow around
//! them. The pod is the file system: opening a file reads it from there, an
//! edit hands its text back to the browser (which writes it), and the bytes a
//! staged deletion no longer has on disk come from the workspace's own blob
//! cache. The TypeScript intelligence — diagnostics, hover, go-to-definition
//! and inline prediction — lives behind `editor-intel.ts`, which the pane
//! feeds the open file's state and the editor pierre attaches. Everything
//! crosses through `host`.

import { errorMessage } from "../errors";
import type { SearchParam } from "../search-param";
import { curatedLang } from "../shiki-langs";
import { createEditorIntel } from "./editor-intel";
import { isScriptFile } from "./intel-protocol";
import type { IntelPosition } from "./intel-protocol";
import { THEME } from "./pane";
import type { DiffsModule, EditModule } from "./pierre";
import { TEXT_MAX_BYTES, isTextBytes } from "./uploads";
import { projectPath } from "./workspace/types";
import type { ChangeKind, Workspace, WorkspaceChange } from "./workspace/types";

/** Pierre's built-in marker popover would open on the same token as the hover
 * tip and overlap it; the tip renders the diagnostics itself (one stack), so
 * the built-in popover is hidden. `unsafeCSS` is pierre's own escape hatch into
 * the file container's shadow root, where that popover lives. */
const HIDE_MARKER_POPOVER_CSS = "[data-marker-popover] { display: none; }";

/** Inline prediction only applies where the worker can complete: TS/JS, with
 * declarations excepted (their text is generated, nobody types them). */
const PREDICTION_INCLUDE = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.mts",
  "**/*.cts",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
] as const;

const PREDICTION_EXCLUDE = ["**/*.d.ts", "**/*.d.mts", "**/*.d.cts"] as const;

/** What the pane shows for a file it will not render as text — bytes that are
 * not text, or text past the size the editor works under. Both are read-only:
 * no edit session can form on a placeholder. */
const BINARY_PLACEHOLDER = "(binary file — preview not available)";
const OVERSIZE_PLACEHOLDER = "(file exceeds 256 KB — preview not available)";

/** The letter the header paints the open file's change as. The tree's own lane
 * spells the kinds the same way (pierre draws the letters from its status), so
 * the two panes never disagree; the kind itself comes from the workspace's
 * changes, the same list the tree marks from. */
const CHANGE_LETTER = {
  added: "A",
  deleted: "D",
  modified: "M",
  moved: "R",
} satisfies Record<ChangeKind, string>;

const DECODER = new TextDecoder();

/** What the pod holds at a path, as the pane reads it. */
interface DiskRead {
  /** The placeholder bytes with no text show, or null when the text is real. */
  placeholder: string | null;
  text: string;
}

/** What the pane should show for a path, and whether it may be edited. */
interface Show {
  contents: string;
  editable: boolean;
  placeholder: string | null;
}

/** What the editor pane needs from the browser, the tree and the workspace. */
export interface EditorHost {
  aborted: () => boolean;
  appId: string;
  /** The workspace's changes, as of the last derive: the worker's own copy of
   * the program is built out of their texts. */
  changes: () => readonly WorkspaceChange[];
  /** The pane's body (`paneIn`): what pierre mounts into, and the one
   * container a paint wipes. The hover tip hangs in the pane above it (see
   * `pane.ts`), so it outlives every placeholder and note. */
  codeEl: HTMLElement;
  diffs: DiffsModule;
  edit: EditModule;
  /** The browser's write of an edit's text into the pod, and its report to the
   * page. The tree's markers and the panel's rows follow from the derive the
   * write triggers. Resolves when the pod holds the text, which is what tells
   * the pane a read of its own write will see it. */
  editChanged: (path: string, text: string) => Promise<void>;
  file: SearchParam<string>;
  /** The ref the checkout under the pane is browsing: read, never captured —
   * a branch switch installs another checkout under this same pane, and every
   * read here (the committed text, the worker's sources) has to follow it. */
  gitRef: () => string;
  /** The checkout the pane drives, as of now: the browser installs another one
   * when the browsed ref changes, and the pane follows it without being
   * rebuilt (its edit session and its intel worker are the pane's own). */
  workspace: () => Workspace;
}

/** The editor pane's surface for the browser and the tree wiring. */
export interface EditorPane {
  /** The pierre teardown: the File view and its editor. Called last, after the
   * tree's own cleanup. */
  cleanUp: () => void;
  /** Drop the edit session, the pending diagnostics and the intel worker. */
  dispose: () => void;
  /** Close the open file without reopening it (a change that took it away). */
  dropOpen: () => void;
  /** The checkout under the pane changed (a branch switch): the open file's
   * text and path, its edit session and the worker's session all belong to the
   * checkout that went, so they go — while what the pane *shows* stays
   * standing, until the next `openFile` paints the new ref's file over it. */
  rebase: () => void;
  /** Re-key the open file's path and text when a move carried it off (a folder
   * move carries everything under it). */
  followMove: (from: string, to: string) => void;
  getCurrentPath: () => string | null;
  /** Open `path`; answers whether the pane shows it at all (`false` for a
   * folder row, or a path neither the pod nor the commit has a file at). */
  openFile: (path: string, caret?: IntelPosition) => Promise<boolean>;
  /** Hand the caret back to `path` after something else took focus (the tree
   * row a New File names grabs it as the rename lands), unless the user has
   * typed since the file opened. */
  reclaimCaret: (path: string, caret: IntelPosition) => void;
  /** Re-sync the worker from scratch (a push changed the repo). */
  resetIntel: () => void;
  startedIntel: () => boolean;
  /** The pod moved under the pane (an FS event named the open path): repaint
   * what changed, refill the worker, and close a file that is gone. */
  syncOpen: () => Promise<void>;
}

export const createEditorPane = (host: EditorHost): EditorPane => {
  const { diffs } = host;
  // Live text per open path: the editor's own copy is the truth while a file
  // is open, and every editor position (token, cursor) becomes an offset
  // against it before the worker sees it.
  const liveText = new Map<string, string>();
  let currentPath: string | null = null;
  let currentEditable = false;
  /** What the code surface holds now: the open path's text and whether it has
   * an edit session, or the placeholder a file with no text shows. `syncOpen`
   * compares the pod against this to know when a repaint is needed. */
  let shown: (Show & { path: string }) | null = null;
  /** The text this pane handed to the pod whose write has not resolved yet,
   * per open path. A read of the pod that runs while one of the pane's own
   * writes is still landing comes back with bytes older than the editor, and
   * repainting from them would drop the keystroke that is in them. */
  const pendingWrites = new Map<string, string>();
  /** Edits the user has made in this pane. A caret the pane was asked for
   * lands only if no edit happened since it was asked for: Playwright and
   * people alike type between frames, and a caret placed after the first
   * keystroke sends the rest of the typing in front of it (`xport const
   * extra = 1;e` in a new file). */
  let edits = 0;
  /** `edits` as of the open file's last paint, or a re-open nobody typed
   * through. */
  let editsAtOpen = 0;
  // The open file's change, in the code header beside its name: pierre renders
  // the header from a shadow root with a slot for it, and the chip rides along
  // as light DOM. It reads the same workspace changes the tree marks from, so
  // an edit, a discard, an undo or another tab's write shows in both without
  // the pane keeping a second copy of the state.
  const statusChip = document.createElement("span");
  statusChip.className = "noite-src-change";
  statusChip.slot = "header-filename-suffix";
  statusChip.hidden = true;

  /** Paint the change at `path` into the header chip, or hide it when the
   * workspace has none there. */
  const paintStatus = (path: string | null): void => {
    const change =
      path === null
        ? undefined
        : host.changes().find((one) => one.path === path);

    if (change === undefined) {
      statusChip.hidden = true;

      return;
    }

    statusChip.dataset.changeKind = change.kind;
    statusChip.textContent = CHANGE_LETTER[change.kind];
    statusChip.hidden = false;
  };

  /** Put the chip in the header slot: pierre renders the header from a shadow
   * root, and the chip carries the header's slot as its light DOM. */
  const attachStatus = (container: Element | null): void => {
    if (container !== null && statusChip.parentNode !== container) {
      container.append(statusChip);
    }
  };

  // The intelligence layer is built before the editor it paints through, so
  // the open file reaches it as live accessors rather than as values.
  const intel = createEditorIntel({
    aborted: host.aborted,
    appId: host.appId,
    changes: host.changes,
    codeEl: host.codeEl,
    currentEditable: () => currentEditable,
    currentPath: () => currentPath,
    diffs,
    gitRef: host.gitRef,
    liveText,
  });

  let disposeEdit: (() => void) | undefined;
  let activePreview = 0;
  /** The path the latest `openFile` is still resolving, or null once it has
   * painted, given up or been superseded. */
  let opening: string | null = null;

  const editor = new host.edit.Editor("file", {
    editPrediction: {
      exclude: PREDICTION_EXCLUDE,
      include: PREDICTION_INCLUDE,
      provider: { predict: intel.predict },
    },
    onAttach: intel.onAttach,
  });

  // Draft bookkeeping for the pierre editor: an edit that lands back on the
  // commit's text leaves no change behind, which the derive settles on its
  // own — the text goes to the pod either way.
  const handleEditChange = () => {
    const path = currentPath;

    if (path === null || !currentEditable) {
      return;
    }

    edits += 1;

    const text = editor.getText();
    liveText.set(path, text);

    if (shown !== null) {
      shown = {
        contents: text,
        editable: shown.editable,
        path: shown.path,
        placeholder: shown.placeholder,
      };
    }

    pendingWrites.set(path, text);

    const settle = async () => {
      try {
        await host.editChanged(path, text);
      } catch {
        // The pod refused the write: the pane keeps the text it has, and the
        // next derive re-reads whatever the pod really holds (see `syncOpen`).
      }

      if (pendingWrites.get(path) === text) {
        pendingWrites.delete(path);
      }
    };

    void settle();
    intel.scheduleDiagnostics();
  };

  const fileView = new diffs.File({
    onEditChange: handleEditChange,
    overflow: "scroll",
    theme: THEME,
  });

  /** What the pod holds at `path`, or null when it holds no file there (a
   * folder row, or a path that never was one). */
  const readDisk = async (path: string): Promise<DiskRead | null> => {
    const abs = projectPath(path);

    if (!(await host.workspace().fs.exists(abs))) {
      return null;
    }

    const { isFile } = await host.workspace().fs.stat(abs);

    if (!isFile) {
      return null;
    }

    const bytes = await host.workspace().fs.readFile(abs);

    if (!isTextBytes(bytes)) {
      return { placeholder: BINARY_PLACEHOLDER, text: "" };
    }

    if (bytes.byteLength > TEXT_MAX_BYTES) {
      return { placeholder: OVERSIZE_PLACEHOLDER, text: "" };
    }

    return { placeholder: null, text: DECODER.decode(bytes) };
  };

  /** What an open may show of `path`: the pod's own file, the committed text
   * read-only when the pod no longer has one (a staged deletion — the checkout
   * is where those bytes are), or nothing at all when neither holds a text
   * file. */
  const resolveShow = async (path: string): Promise<Show | null> => {
    const disk = await readDisk(path);

    if (disk !== null) {
      return disk.placeholder === null
        ? {
            contents: disk.text,
            editable: host.workspace().editable,
            placeholder: null,
          }
        : { contents: "", editable: false, placeholder: disk.placeholder };
    }

    const committed = await host.workspace().baseText(path);

    return committed === null
      ? null
      : { contents: committed, editable: false, placeholder: null };
  };

  /** Whether the code surface already holds exactly what `show` describes for
   * `path`: painting it again would rebuild the same document, and that (not
   * the text) is what drops the caret's place and the edit session's focus. */
  const shows = (path: string, show: Show): boolean =>
    shown !== null &&
    shown.path === path &&
    shown.editable === show.editable &&
    shown.placeholder === show.placeholder &&
    shown.contents === show.contents;

  /** What opening a file starts from: the previous file's session, markers,
   * hover tip and any check still running are stale from here on; the
   * intelligence layer drops its own half while the old session is still
   * attached. */
  const beginPreview = (path: string) => {
    currentPath = path;
    // Mirror the open file into the URL (deep-linkable).
    host.file.set(path);
    intel.beginPreview(path);
    // A new file always starts detached; text re-attaches in `paint`.
    disposeEdit?.();
    disposeEdit = undefined;
  };

  /** Paint a file: the code surface, the edit session a text file of the pod's
   * own gets, and the intelligence layer's first look at it. */
  const paint = (path: string, show: Show, caret?: IntelPosition) => {
    beginPreview(path);
    currentEditable = show.editable;
    editsAtOpen = edits;
    shown = {
      contents: show.contents,
      editable: show.editable,
      path,
      placeholder: show.placeholder,
    };

    if (show.placeholder !== null) {
      liveText.delete(path);
      host.codeEl.textContent = show.placeholder;
      paintStatus(path);

      return;
    }

    // The note a wait or a click painted, or the last placeholder, goes:
    // leaving it would stack the file under stale text. Pierre's own container
    // stays — a repaint of the same view renders into it and never appends it
    // again. The pane's own furniture (the hover tip) is outside this
    // container (see `pane.ts`).
    let node = host.codeEl.firstChild;

    while (node !== null) {
      const next = node.nextSibling;

      if (node.nodeName.toLowerCase() !== "diffs-container") {
        node.remove();
      }

      node = next;
    }

    liveText.set(path, show.contents);
    fileView.render({
      containerWrapper: host.codeEl,
      file: {
        contents: show.contents,
        lang: curatedLang(path, diffs.getFiletypeFromFileName),
        name: path,
      },
    });
    attachStatus(host.codeEl.querySelector("diffs-container"));
    paintStatus(path);

    if (currentEditable) {
      disposeEdit = editor.edit(fileView);

      if (caret) {
        intel.placeCaret(caret);
      }
    }

    if (isScriptFile(path)) {
      void intel.ensure();
      void intel.runDiagnostics(path);
    }
  };

  /** Open `path` in the pane; `caret` lands the cursor there (used by
   * go-to-definition). A file the pod holds is a real file to the pane and
   * needs no fetch; a path the checkout the pod came from still has opens as
   * its committed text, read-only; a path neither holds is a folder row. */
  const openFile = async (
    path: string,
    caret?: IntelPosition
  ): Promise<boolean> => {
    if (host.aborted()) {
      return false;
    }

    activePreview += 1;
    const previewToken = activePreview;
    const editsAtCall = edits;
    opening = path;

    try {
      const show = await resolveShow(path);

      if (previewToken !== activePreview || host.aborted()) {
        return false;
      }

      if (show === null) {
        return false;
      }

      // The pane may be asked for what it already holds — the tree's own
      // selection follows the open, and a move re-keys the open file without
      // repainting it. Painting that again would rebuild the same document for
      // nothing (and take the caret's place with it), so only the deep link
      // and the caret asked for here are applied. The same holds while one of
      // the pane's own writes to it is landing: the read is older than the
      // editor (see `syncOpen`), and painting it would drop the keystrokes in
      // that write. A caret asked for before the user typed in this document
      // is stale.
      if (
        shows(path, show) ||
        (path === currentPath && pendingWrites.has(path))
      ) {
        if (host.file() !== path) {
          host.file.set(path);
        }

        if (edits === editsAtCall) {
          editsAtOpen = edits;

          if (caret) {
            intel.placeCaret(caret);
          }
        }

        return true;
      }

      paint(path, show, caret);

      return true;
    } catch (error) {
      if (previewToken === activePreview && !host.aborted()) {
        host.codeEl.textContent = errorMessage(error);
      }

      return false;
    } finally {
      if (previewToken === activePreview) {
        opening = null;
      }
    }
  };

  /** Close the open file: nothing shows it any more. */
  const dropOpen = () => {
    const path = currentPath;

    if (path === null) {
      return;
    }

    currentPath = null;
    currentEditable = false;
    shown = null;
    disposeEdit?.();
    disposeEdit = undefined;
    intel.detachSession();
    liveText.delete(path);
    host.codeEl.textContent = "";
    paintStatus(null);
  };

  /** The checkout under the pane changed: the open file, its edit session and
   * the worker's session are the old ref's, so they go — what the pane shows
   * stays standing until the next `openFile` paints over it. In-flight opens
   * of the old checkout answer into nothing (their token is spent). */
  const rebase = () => {
    activePreview += 1;
    opening = null;
    currentPath = null;
    currentEditable = false;
    shown = null;
    disposeEdit?.();
    disposeEdit = undefined;
    intel.detachSession();
    liveText.clear();
    pendingWrites.clear();
    paintStatus(null);
  };

  /** The pod moved under the pane: repaint whatever the code surface is not
   * already showing — a discard, a restore, an upload replacing the bytes, a
   * push that landed on another branch, a staged deletion — and close the pane
   * for a file that is gone from both the pod and the checkout. The pane's own
   * writes are the one thing it must not paint over: a read taken while one is
   * in flight is older than the editor, so it is skipped (the write's own
   * derive comes back here with bytes it can trust). */
  const syncOpen = async (): Promise<void> => {
    const path = currentPath;

    if (path === null || host.aborted()) {
      return;
    }

    // The pane is leaving this file: the open of another one owns the code
    // surface. Superseding it would strand the outgoing file on screen (and in
    // `?file=`) while the open the user asked for answers into nothing.
    if (opening !== null && opening !== path) {
      return;
    }

    // The change may be all that moved (an edit settling on the commit's text
    // leaves no change, a new one arrives): the header follows it here, before
    // any of the reads below can short-circuit.
    attachStatus(host.codeEl.querySelector("diffs-container"));
    paintStatus(path);
    activePreview += 1;
    const previewToken = activePreview;
    opening = null;
    // A write of the pane's own is in flight: the pod may answer with bytes
    // older than the editor, so this read is not one to compare against.
    const writing = pendingWrites.has(path);
    const show = await resolveShow(path);

    if (
      previewToken !== activePreview ||
      path !== currentPath ||
      host.aborted()
    ) {
      return;
    }

    if (writing || pendingWrites.has(path)) {
      intel.scheduleDiagnostics();

      return;
    }

    if (show === null) {
      dropOpen();

      return;
    }

    if (shows(path, show)) {
      intel.scheduleDiagnostics();

      return;
    }

    paint(path, show);
  };

  const followMove = (from: string, to: string) => {
    const moved = (path: string): string =>
      path === from || path.startsWith(`${from}/`)
        ? `${to}${path.slice(from.length)}`
        : path;

    // Re-keying the entry being visited is safe: the map holds the open files
    // only, and a move never lands inside the path it came from.
    for (const [path, text] of liveText) {
      const next = moved(path);

      if (next !== path) {
        liveText.delete(path);
        liveText.set(next, text);
      }
    }

    if (currentPath !== null) {
      currentPath = moved(currentPath);
    }

    if (shown !== null) {
      shown = {
        contents: shown.contents,
        editable: shown.editable,
        path: moved(shown.path),
        placeholder: shown.placeholder,
      };
    }
  };

  // `File.setOptions` replaces the whole option set, so the hooks are added
  // to a copy of what the component was built with. The click hook needs the
  // pane's own open path (go-to-definition jumps through it), which only
  // exists from here on.
  fileView.setOptions({
    onEditChange: handleEditChange,
    // The header is re-rendered (a worker highlight lands, another file opens):
    // the chip rides along as the header slot's light DOM, so it is put back.
    onPostRender: attachStatus,
    onTokenClick: (props, event) => {
      intel.tokenClick(props, event, openFile);
    },
    onTokenEnter: (props) => {
      void intel.tokenEnter(props);
    },
    onTokenLeave: intel.tokenLeave,
    overflow: "scroll",
    theme: THEME,
    unsafeCSS: HIDE_MARKER_POPOVER_CSS,
  });

  const dispose = () => {
    disposeEdit?.();
    disposeEdit = undefined;
    intel.dispose();
  };

  const cleanUp = () => {
    fileView.cleanUp();
    editor.cleanUp();
  };

  const reclaimCaret = (path: string, caret: IntelPosition) => {
    if (path === currentPath && edits === editsAtOpen) {
      intel.placeCaret(caret);
    }
  };

  return {
    cleanUp,
    dispose,
    dropOpen,
    followMove,
    getCurrentPath: () => currentPath,
    openFile,
    rebase,
    reclaimCaret,
    resetIntel: intel.reset,
    startedIntel: intel.started,
    syncOpen,
  };
};
