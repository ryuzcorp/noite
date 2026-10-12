//! The vendor shapes the source pane writes against: `@pierre/trees` and
//! `@pierre/diffs`, narrowed to the surface the browser and its panes actually
//! call. Types only — the real modules stay behind the dynamic imports in
//! `browser.tsx`, and the minimal interfaces here bridge to them structurally.

import type { TokenEventBase } from "@pierre/diffs";
import type {
  EditorChangeEvent,
  EditorOptions,
  Marker,
  Range,
} from "@pierre/diffs/edit";

/** Minimal shapes — the real types live in @pierre/* once installed. */
export interface PreparedTreeInput {
  paths: readonly string[];
  presorted: true;
}

/** The statuses this pane paints in the tree, as pierre names them. */
export type TreeGitStatus = "added" | "deleted" | "modified" | "renamed";

export interface TreeStatusEntry {
  path: string;
  status: TreeGitStatus;
}

/** The row a menu stands for (pierre's `ContextMenuItem`): the callback only
 * reads the path; folder paths are canonical and end with "/". */
export interface TreeContextMenuItem {
  path: string;
}

/** Where the menu opened (pierre's `ContextMenuOpenContext`): the click point,
 * and pierre's own close — which settles its menu state and hands focus back
 * to the tree unless the caller is about to take it somewhere else. */
export interface TreeContextMenuContext {
  anchorRect: { x: number; y: number };
  close: (options?: { restoreFocus?: boolean }) => void;
}

/** What an inline rename landed on (pierre's `FileTreeRenameEvent`); the
 * destination is a sibling of the source, so only the leaf changes. */
export interface TreeRenameEvent {
  destinationPath: string;
  isFolder: boolean;
  sourcePath: string;
}

/** Where a drop landed (pierre's `FileTreeDropTarget`): a folder row or the
 * root — `directoryPath` is the folder a drop into it lands in. */
export interface TreeDropTarget {
  directoryPath: string | null;
  kind: "directory" | "root";
}

export interface TreeDropContext {
  draggedPaths: readonly string[];
  target: TreeDropTarget;
}

/** A drop pierre has already applied to its store (pierre's
 * `FileTreeDropResult`): the rows moved, where they landed. */
export type TreeDropResult = TreeDropContext;

/** The pierre options this pane writes: the context menu rides inside
 * `composition`, but `renaming` and `dragAndDrop` are top-level fields
 * (`FileTreeOptions` = behavior options + the composition surface — nesting
 * `renaming` under `composition` leaves inline renaming disabled and
 * `startRenaming` then returns false). */
export interface FileTreeOptions {
  composition?: {
    contextMenu?: {
      enabled?: boolean;
      onClose?: () => void;
      onOpen?: (
        item: TreeContextMenuItem,
        context: TreeContextMenuContext
      ) => void;
      triggerMode?: "both" | "button" | "right-click";
    };
  };
  dragAndDrop?: {
    /** Asked while hovering and again on the drop: false withdraws the target
     * (pierre then leaves the tree alone). */
    canDrop?: (drop: TreeDropContext) => boolean;
    /** The drop is already in pierre's store here; a collision arrives through
     * `onDropError` instead, with the tree untouched. */
    onDropComplete?: (drop: TreeDropResult) => void;
    onDropError?: (error: string, drop: TreeDropContext) => void;
  };
  gitStatus?: readonly TreeStatusEntry[];
  initialExpandedPaths?: string[];
  initialSelectedPaths?: readonly string[];
  onSelectionChange?: (selected: readonly string[]) => void;
  preparedInput: PreparedTreeInput;
  renaming?: {
    /** Asked before an inline rename starts: the placeholder of an add is the
     * only row this pane lets pierre rename (see `startAdd`). */
    canRename: (item: { isFolder: boolean; path: string }) => boolean;
    onError: (error: string) => void;
    onRename: (event: TreeRenameEvent) => void;
  };
  search?: boolean;
}

/** The mounted tree: the pierre calls the browser makes after construction. */
export interface Tree {
  add: (path: string) => void;
  cleanUp: () => void;
  /** Present for any stored path, visible or not; null once it is gone. */
  getItem: (path: string) => { select: () => void } | null;
  /** The selected rows (Ctrl/Cmd/Shift-click adds to it), folders with "/". */
  getSelectedPaths: () => readonly string[];
  remove: (path: string) => void;
  render: (opts: { fileTreeContainer: HTMLElement }) => void;
  setGitStatus: (entries?: readonly TreeStatusEntry[]) => void;
  startRenaming: (
    path: string,
    options?: { removeIfCanceled?: boolean }
  ) => boolean;
}

export interface TreesModule {
  FileTree: new (opts: FileTreeOptions) => Tree;
  preparePresortedFileTreeInput: (paths: string[]) => PreparedTreeInput;
}

/** Minimal pierre File view surface (render target + edit attach + the late
 * option write the token hooks need — see the wiring in `SourceBrowser`). */
export interface PierreFileView {
  cleanUp: () => void;
  render: (opts: {
    containerWrapper: HTMLElement | null;
    file: { contents: string; name: string; lang?: string };
  }) => void;
  setOptions: (options: FileOptions) => void;
}

/** Minimal pierre editor surface: attach to a File view, read text, and the
 * three calls the intelligence layer makes — markers, caret placement and
 * focus. The full Editor class carries generics the vanilla side never needs. */
export interface PierreEditor {
  cleanUp: () => void;
  edit: (file: PierreFileView) => () => void;
  /** Scroll to and focus a 1-based document line (see pierre's
   * `EditorFocusOptions`). */
  focus: (options?: { character?: number; lineNumber?: number }) => void;
  getText: () => string;
  setMarkers: (markers: Marker[]) => void;
  setSelections: (
    selections: (Range & { direction: "none" | "backward" | "forward" })[]
  ) => void;
}

/** What the intelligence layer writes to: markers and a caret. A `Pick` of the
 * minimal view above because pierre hands its own (wider) `Editor` class to
 * `onAttach`, and the file never needs the rest of it there. */
export type MarkerTarget = Pick<
  PierreEditor,
  "focus" | "setMarkers" | "setSelections"
>;

export interface EditModule {
  Editor: new (
    type: "file",
    options?: EditorOptions<"file", undefined, undefined>,
    editStateKey?: string
  ) => PierreEditor;
}

/** Token hooks are `InteractionManagerBaseOptions<'file'>` on the File: the
 * element carries `data-line` (1-based) and `data-char` (0-based character
 * offset in that line) — see pierre's `FileRenderer`/`InteractionManager`. */
export interface FileOptions {
  theme?: unknown;
  overflow?: string;
  unsafeCSS?: string;
  /** Fired after every render of the container (mount, update and unmount): the
   * pane hangs the header's change chip on it, so it survives a re-render. */
  onPostRender?: (node: HTMLElement) => void;
  onEditChange?: (
    event: EditorChangeEvent<"file", undefined, undefined>
  ) => void;
  onTokenClick?: (props: TokenEventBase, event: MouseEvent) => void;
  onTokenEnter?: (props: TokenEventBase, event: PointerEvent) => void;
  onTokenLeave?: (props: TokenEventBase, event: PointerEvent) => void;
}

export interface DiffsModule {
  File: new (opts?: FileOptions) => PierreFileView;
  getFiletypeFromFileName: (filename: string) => string;
  preloadHighlighter: (opts: {
    langs: string[];
    themes: string[];
  }) => Promise<void>;
}
