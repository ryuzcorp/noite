/**
 * Source browser: file tree (@pierre/trees) + code preview and editor
 * (@pierre/diffs), both mounted imperatively from their vanilla APIs.
 *
 * The two pane hosts use `ref` callbacks; setup runs once in
 * `watch.once(async ({ signal, onCleanup }) => …)` (client-only, once per
 * mount) and aborts via `signal` on unmount. Draft/push state flows back
 * through `onState`. The pierre `onEditChange` stays imperative — only the
 * derived counts cross into atoms.
 *
 * Data comes from the runner's bare-mirror endpoints via server-side actions
 * (sourceTree / sourceBlob) — the browser never sees tokens.
 *
 * The pane also speaks TypeScript: `SourceIntel` (./intel) drives a lazily
 * created language-service worker that gets the repo's sources, the build's
 * captured declarations and every draft, and answers diagnostics (pierre
 * markers), hover, go-to-definition and inline prediction. Everything the
 * compiler needs stays in that worker — the main bundle never imports it.
 */
import type { TokenEventBase } from "@pierre/diffs";
import type {
  EditPredictContext,
  EditPredictRequest,
  EditPredictResponse,
  EditorChangeEvent,
  EditorOptions,
  Marker,
  Position,
  Range,
} from "@pierre/diffs/edit";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { errorMessage } from "../errors";
import { collectRef, newLiveRef, whenLive } from "../live-ref";
import type { LiveRef } from "../live-ref";
import type { RunnerBlob } from "../runner";
import type { SearchParam } from "../search-param";
import {
  sourceBlob,
  sourceBundle,
  sourceCommit,
  sourceTree,
  sourceTypes,
} from "../server/source.server";
import type { SourceCommitInput } from "../server/source.server";
import { CURATED_SHIKI_LANGS } from "../shiki-langs";
import { readSwr, writeSwr } from "../swr-store";
import { SourceIntel } from "./intel";
import {
  completionRemainder,
  diagnosticsToMarkers,
  isScriptFile,
  lineStarts,
  offsetAtPosition,
  positionAtOffset,
  supportsPrediction,
} from "./intel-protocol";
import type { IntelPosition, IntelSources } from "./intel-protocol";

/** Sort flat file paths so folders come first at every level, then
 * files — alphabetical within each group (segment-wise compare). */
const sortTreePaths = (paths: string[]): string[] =>
  paths.toSorted((a, b) => {
    const as = a.split("/");
    const bs = b.split("/");
    const len = Math.min(as.length, bs.length);
    for (let i = 0; i < len; i += 1) {
      const charA = as[i] ?? "";
      const charB = bs[i] ?? "";
      if (charA !== charB) {
        const aIsDir = i < as.length - 1;
        const bIsDir = i < bs.length - 1;
        if (aIsDir !== bIsDir) {
          return aIsDir ? -1 : 1;
        }
        return charA < charB ? -1 : 1;
      }
    }
    return as.length - bs.length;
  });

const THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

/** Diagnostics re-run this long after the last keystroke (a full program check
 * per keystroke would fight the user's typing). */
const DIAGNOSTICS_DELAY = 400;

/** The pointer rests on a token this long before its hover tip opens, the
 * same delay pierre uses for its diagnostic popovers. */
const HOVER_DELAY = 300;

/** Pierre's token color variables (`--diffs-token-light` / `-dark`): the tip
 * highlights with the same prefix, so its colors follow the editor's theme. */
const TOKEN_VAR_PREFIX = "--diffs-token-";

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

/** Map a filename to its highlight language, capped to the curated set. */
const curatedLang = (
  name: string,
  resolve: (filename: string) => string
): string => {
  const lang = resolve(name);
  return CURATED_SHIKI_LANGS.includes(lang) ? lang : "text";
};

/** Minimal shapes — the real types live in @pierre/* once installed. */
interface PreparedTreeInput {
  paths: readonly string[];
  presorted: true;
}

interface TreesModule {
  FileTree: new (opts: {
    preparedInput: PreparedTreeInput;
    search?: boolean;
    initialExpandedPaths?: string[];
    initialSelectedPaths?: readonly string[];
    onSelectionChange?: (selected: readonly string[]) => void;
  }) => {
    render: (opts: { fileTreeContainer: HTMLElement }) => void;
    subscribe: (fn: () => void) => void;
    getSelectedPaths: () => string[];
    cleanUp: () => void;
  };
  preparePresortedFileTreeInput: (paths: string[]) => PreparedTreeInput;
}

/** Minimal pierre File view surface (render target + edit attach + the late
 * option write the token hooks need — see the wiring in `SourceBrowser`). */
interface PierreFileView {
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
interface PierreEditor {
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
type MarkerTarget = Pick<
  PierreEditor,
  "focus" | "setMarkers" | "setSelections"
>;

interface EditModule {
  Editor: new (
    type: "file",
    options?: EditorOptions<"file", undefined, undefined>,
    editStateKey?: string
  ) => PierreEditor;
}

/** Token hooks are `InteractionManagerBaseOptions<'file'>` on the File: the
 * element carries `data-line` (1-based) and `data-char` (0-based character
 * offset in that line) — see pierre's `FileRenderer`/`InteractionManager`. */
interface FileOptions {
  theme?: unknown;
  overflow?: string;
  onEditChange?: (
    event: EditorChangeEvent<"file", undefined, undefined>
  ) => void;
  onTokenClick?: (props: TokenEventBase, event: MouseEvent) => void;
  onTokenEnter?: (props: TokenEventBase, event: PointerEvent) => void;
  onTokenLeave?: (props: TokenEventBase, event: PointerEvent) => void;
}

interface DiffsModule {
  File: new (opts?: FileOptions) => PierreFileView;
  getFiletypeFromFileName: (filename: string) => string;
  getSharedHighlighter: (opts: {
    langs: string[];
    themes: string[];
  }) => Promise<TipHighlighter>;
  preloadHighlighter: (opts: {
    langs: string[];
    themes: string[];
  }) => Promise<void>;
}

/** The slice of pierre's shared shiki highlighter the hover tip uses. */
interface TipHighlighter {
  codeToTokens: (
    code: string,
    opts: {
      cssVariablePrefix: string;
      defaultColor: false;
      lang: string;
      themes: typeof THEME;
    }
  ) => { tokens: { content: string; htmlStyle?: Record<string, string> }[][] };
}

/** The runner's tree listing for the latest pushed commit. */
type TreeData = Awaited<ReturnType<typeof sourceTree>>;

/** Per-instance browser state that must outlive re-renders (see below). */
interface BrowserBox {
  /** Pane hosts as live refs: re-renders also hand `ref` detached scratch
   * copies, so the setup resolves the connected host (live-ref.ts). */
  code: LiveRef<HTMLElement>;
  hostsReady: PromiseWithResolvers<boolean>;
  tree: LiveRef<HTMLElement>;
}

const newBrowserBox = (): BrowserBox => ({
  code: newLiveRef<HTMLElement>(),
  hostsReady: Promise.withResolvers<boolean>(),
  tree: newLiveRef<HTMLElement>(),
});

/** One edited file: its text at the browsed commit and the draft. */
export interface DraftFile {
  after: string;
  before: string;
  path: string;
}

/** Where the last push landed (`newBranch`: the push created `branch`). */
export interface PushedTo {
  branch: string;
  newBranch: boolean;
}

/** Draft/push state reported to the page (the Changes panel renders it). */
export interface SourceBrowserState {
  files: DraftFile[];
  pushError: string;
  pushed: PushedTo | null;
  pushing: boolean;
  /** Bumped on every draft change: a key for views rebuilt from `files`. */
  revision: number;
}

/** A push the Changes panel asks for. `branch` names a new branch to commit
 * to (from the default branch's tip); omitted, the commit goes to the
 * default branch. */
export interface PushRequest {
  branch?: string;
  message: string;
}

/** Commits the drafts as `request` asks; resolves whether the push landed. */
export type CommitDrafts = (request: PushRequest) => Promise<boolean>;

/** Styles inside each pane's shadow root: fill the host, stretch the
 * content-sized pierre element so short files still fill the code area, and
 * dress the hover tip (which lives in this root, so it needs its own rules —
 * and inherits the theme's custom properties, light or dark, from the host). */
const PANE_CSS = `
:host { display: block; }
.pane { display: flex; flex-direction: column; min-height: 100%; position: relative; }
.pane > :not(.intel-tip) { flex: 1; min-height: 100%; }
.intel-tip {
  position: absolute;
  z-index: 20;
  box-sizing: border-box;
  width: max-content;
  max-width: min(40rem, calc(100% - 1rem));
  height: auto;
  max-height: 16rem;
  overflow: auto;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-base-300, #444);
  border-radius: var(--radius-box, 0.5rem);
  background: var(--color-base-100, #1b1b1b);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  color: var(--color-base-content, #ddd);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.4;
  pointer-events: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.intel-tip[hidden] { display: none; }
.intel-code span {
  color: light-dark(var(--diffs-token-light, inherit), var(--diffs-token-dark, inherit));
}
.intel-head { opacity: 0.7; margin-bottom: 0.25rem; }
.intel-docs {
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--color-base-300, #444);
  font-family: var(--font-sans, system-ui, sans-serif);
}
`;

/** Work the current file computed before its edit session could take it. The
 * session is only marker-ready (and only focusable) after the editor reports
 * the attach, so what is computed earlier is parked here and painted then. */
interface PendingIntel {
  caret?: IntelPosition;
  markers?: Marker[];
  path?: string;
}

/** What a hover tip shows: code highlighted as `lang`, an optional plain
 * header above it and plain doc lines under it. */
interface TipContent {
  code: string;
  docs: readonly string[];
  header?: string;
  lang: string;
}

/** The hover tip: quick info, or the declaration lines of a definition the
 * pane cannot open. TypeScript output only ever becomes text nodes; the
 * highlighting is per-token spans, never HTML. */
interface HoverTip {
  hide: () => void;
  show: (content: TipContent, anchor: HTMLElement) => Promise<void>;
}

/** `code` as one span per shiki token, colored through pierre's variables;
 * plain text when the highlighter is unavailable. */
const highlightInto = async (
  el: HTMLElement,
  { code, lang }: TipContent,
  highlighter: () => Promise<TipHighlighter>
): Promise<void> => {
  let lines: { content: string; htmlStyle?: Record<string, string> }[][];
  try {
    const shiki = await highlighter();
    ({ tokens: lines } = shiki.codeToTokens(code, {
      cssVariablePrefix: TOKEN_VAR_PREFIX,
      defaultColor: false,
      lang,
      themes: THEME,
    }));
  } catch {
    el.textContent = code;
    return;
  }
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      el.append("\n");
    }
    for (const token of line) {
      const span = document.createElement("span");
      span.textContent = token.content;
      for (const [name, value] of Object.entries(token.htmlStyle ?? {})) {
        span.style.setProperty(name, value);
      }
      el.append(span);
    }
  }
};

const createHoverTip = (
  pane: HTMLElement,
  highlighter: () => Promise<TipHighlighter>
): HoverTip => {
  const tip = document.createElement("div");
  tip.className = "intel-tip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  pane.append(tip);
  // Every show/hide bumps this; a show still highlighting when a newer call
  // lands must not open.
  let generation = 0;
  return {
    hide: () => {
      generation += 1;
      tip.hidden = true;
    },
    show: async (content, anchor) => {
      generation += 1;
      const mine = generation;
      const body = document.createElement("div");
      if (content.header) {
        const head = document.createElement("div");
        head.className = "intel-head";
        head.textContent = content.header;
        body.append(head);
      }
      if (content.code !== "") {
        const code = document.createElement("div");
        code.className = "intel-code";
        await highlightInto(code, content, highlighter);
        body.append(code);
      }
      if (content.docs.length > 0) {
        const docs = document.createElement("div");
        docs.className = "intel-docs";
        docs.textContent = content.docs.join("\n");
        body.append(docs);
      }
      if (mine !== generation || !anchor.isConnected) {
        return;
      }
      tip.replaceChildren(...body.childNodes);
      tip.hidden = false;
      const paneBox = pane.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      // Clamp into the pane: the tip must not introduce horizontal scroll.
      const left = Math.max(
        0,
        Math.min(
          anchorBox.left - paneBox.left,
          pane.clientWidth - tip.offsetWidth - 8
        )
      );
      tip.style.left = `${left}px`;
      tip.style.top = `${anchorBox.bottom - paneBox.top + 4}px`;
    },
  };
};

/** The mount point pierre renders into, inside a shadow root on `host`.
 * ilha re-renders this component often (every onState report, every
 * ?file= write), and its morph makes a host's light-DOM children and
 * attributes match the (empty) JSX — deleting pierre's editor nodes
 * and stripping its host styles. Shadow content is invisible to the morph;
 * theme custom properties set on the host still inherit into it. */
const paneIn = (host: HTMLElement): HTMLElement => {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const existing = root.querySelector<HTMLElement>(".pane");
  if (existing) {
    return existing;
  }
  const style = document.createElement("style");
  style.textContent = PANE_CSS;
  const pane = document.createElement("div");
  pane.className = "pane";
  root.append(style, pane);
  return pane;
};

/** The default branch and its tip. An atom rather than plain props: the
 * page mounts the browser once per ref and never re-renders it with new
 * props, while these arrive with the refs after the mount. */
export interface BrowserBase {
  defaultBranch: string;
  /** The tip a browser-created branch starts from (null = the runner's default). */
  mainSha: string | null;
}

export interface SourceBrowserProps {
  appId: string;
  base: AtomHandle<BrowserBase>;
  file: SearchParam<string>;
  /** Branch/tag/SHA the tree is read from; the page defaults it to the
   * default branch. */
  gitRef: string;
  onState: (state: SourceBrowserState) => void;
  /** Called once per mount with the function that commits the drafts. */
  onCommitReady: (commit: CommitDrafts) => void;
}

export const SourceBrowser = ({
  appId,
  base,
  file,
  gitRef,
  onCommitReady,
  onState,
}: SourceBrowserProps) => {
  // Per-instance state that must outlive re-renders; atom.lazy returns the
  // same box every render.
  const box = atom.lazy(newBrowserBox)();
  const attach = (slot: "code" | "tree") => (host: HTMLElement | null) => {
    collectRef(box[slot], host);
    if (box.tree.els.length > 0 && box.code.els.length > 0) {
      box.hostsReady.resolve(true);
    }
  };
  watch.once(async ({ onCleanup, signal }) => {
    // watch.once runs during render, before the JSX (and its refs) exist:
    // wait for both host elements to attach.
    await box.hostsReady.promise;
    // The refs fire before insertion: wait for the hosts that are really in
    // the document, and only then give each its shadow pane (never on a
    // scratch copy the morph is about to discard).
    const [treeHost, codeHost] = await Promise.all([
      whenLive(box.tree, signal),
      whenLive(box.code, signal),
    ]);
    if (signal.aborted || !treeHost || !codeHost) {
      return;
    }
    const treeEl = paneIn(treeHost);
    const codeEl = paneIn(codeHost);
    const aborted = (): boolean => signal.aborted;

    // Drafts live here (never in atoms): the code pane is always
    // pierre-editable — no edit mode, no toggle.
    let pushing = false;
    let pushError = "";
    let pushed: PushedTo | null = null;
    let revision = 0;
    let currentPath: string | null = null;
    let currentEditable = false;
    const drafts = new Map<string, string>();
    const originals = new Map<string, string>();
    const syncState = () => {
      onState({
        files: [...drafts].map(([path, after]) => ({
          after,
          before: originals.get(path) ?? "",
          path,
        })),
        pushError,
        pushed,
        pushing,
        revision,
      });
    };

    let trees: TreesModule;
    let diffs: DiffsModule;
    let editMod: EditModule;
    try {
      const modulesPromise = Promise.all([
        import("@pierre/trees"),
        import("@pierre/diffs"),
        import("@pierre/diffs/edit"),
      ]);
      // SAFETY: import() resolves the installed @pierre modules which structurally match TreesModule/DiffsModule/EditModule.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- vendor types drift from the minimal local interfaces; unknown bridges them.
      const loaded = (await modulesPromise) as unknown as [
        TreesModule,
        DiffsModule,
        EditModule,
      ];
      const [treesMod, diffsMod, editModLoaded] = loaded;
      trees = treesMod;
      diffs = diffsMod;
      editMod = editModLoaded;
    } catch {
      treeEl.textContent =
        "@pierre/trees + @pierre/diffs not installed — run `bun install` in apps/noite";
      return;
    }
    if (aborted()) {
      return;
    }
    const { FileTree, preparePresortedFileTreeInput } = trees;
    const { File } = diffs;
    // Warm only the curated grammars (T6.1); anything else stays plain
    // text and never triggers a grammar download. Fire-and-forget: first
    // paint must not wait on grammar chunks.
    void (async () => {
      try {
        await diffs.preloadHighlighter({
          langs: [...CURATED_SHIKI_LANGS],
          themes: [THEME.dark, THEME.light],
        });
      } catch {
        // Highlighting falls back to on-demand per-file loads.
      }
    })();

    // Live text per open path: the editor's own copy is the truth while a file
    // is open, and every editor position (token, cursor) becomes an offset
    // against it before the worker sees it.
    const liveText = new Map<string, string>();
    const intel = new SourceIntel();
    const tip = createHoverTip(codeEl, () =>
      diffs.getSharedHighlighter({
        langs: [...CURATED_SHIKI_LANGS],
        themes: [THEME.dark, THEME.light],
      })
    );
    /** Only the newest diagnostics run may write markers: a file switch, an
     * edit or a push invalidates whatever is in flight. */
    let intelSeq = 0;
    /** Hover answers arrive out of order too (`quickInfo` is async): only the
     * newest one, for the token the pointer is still on, may open the tip. */
    let hoverSeq = 0;
    /** Cancels the pending debounced diagnostics run, if any. */
    let cancelDiagnostics: (() => void) | undefined;
    let intelStarted = false;
    /** Pierre's edit session only accepts marker ranges once its document is
     * initialized and rendered — `Editor.setMarkers` throws before that, and a
     * throw here would land in `openFile`'s error path and replace the whole
     * pane. Its `onAttach` callback is the readiness signal (see
     * `#scheduleOnAttach` in the editor), so anything computed earlier waits in
     * `pendingIntel`. */
    let sessionReady = false;
    const pendingIntel: PendingIntel = {};

    /** The worker's FS: the repo's sources at the browsing ref plus the
     * declarations captured from the last successful build. Fetched once per
     * mount (twice if a push lands) — a multi-megabyte transfer, so it waits
     * for the first TS/JS file the user actually opens. */
    const loadSources = async (): Promise<IntelSources> => {
      const [bundle, types] = await Promise.all([
        sourceBundle({ appId, ref: gitRef }),
        sourceTypes({ appId }),
      ]);
      return { bundle, types };
    };

    /** Start (or join) the language-service worker, with the drafts as they
     * stand. Memoized inside `SourceIntel`. */
    const ensureIntel = (): Promise<void> => {
      intelStarted = true;
      return intel.sync(
        loadSources,
        [...drafts].map(([path, text]) => ({ path, text }))
      );
    };

    /** Inline prediction: the completion TypeScript ranks first, inserted as
     * ghost text. The provider only ever sees a bounded excerpt, so the cursor
     * is mapped back into the live text before the worker is asked. */
    const predict = async (
      request: EditPredictRequest,
      context: EditPredictContext
    ): Promise<EditPredictResponse> => {
      const cursor: Position = {
        character: request.cursorOffsetInExcerpt,
        line: request.excerptStartLine,
      };
      const nothing: EditPredictResponse = { edits: [], newCursor: cursor };
      const text = liveText.get(request.path);
      if (
        text === undefined ||
        !currentEditable ||
        !supportsPrediction(request.path)
      ) {
        return nothing;
      }
      const offset = offsetAtPosition(text, cursor);
      const completion = await intel.completion(request.path, text, offset);
      if (!completion || context.signal.aborted) {
        return nothing;
      }
      const remainder = completionRemainder(text, offset, completion);
      if (remainder === null) {
        return nothing;
      }
      return {
        edits: [{ newText: remainder, range: { end: cursor, start: cursor } }],
        newCursor: positionAtOffset(
          lineStarts(text),
          offset + remainder.length
        ),
      };
    };

    /** Write what the current file parked onto `target` — markers now that the
     * session can take them, and a caret that was asked for while it could not.
     * Best-effort throughout: a stale session is skipped, never escalated. */
    const paintIntel = (target: MarkerTarget) => {
      if (!sessionReady || pendingIntel.path !== currentPath) {
        return;
      }
      if (pendingIntel.markers && currentEditable) {
        try {
          target.setMarkers(pendingIntel.markers);
        } catch {
          // The session went away between the check and the write: the next
          // attach (or file switch) settles it.
          sessionReady = false;
          return;
        }
      }
      const { caret } = pendingIntel;
      if (caret) {
        pendingIntel.caret = undefined;
        // Two independent best-effort steps: the selection is what the pane
        // paints, and the focus request is delivered by pierre's own render
        // queue (it may land on the next paint) — neither may block the other.
        try {
          target.setSelections([
            { direction: "none", end: caret, start: caret },
          ]);
        } catch {
          // The session moved on; nothing to recover.
        }
        try {
          target.focus();
        } catch {
          // Same: the pane keeps rendering either way.
        }
      }
    };

    /** Drop the previous file's markers while its session is still attached —
     * once it is disposed there is no document left to clear them from. */
    const clearMarkers = (target: MarkerTarget) => {
      if (!(sessionReady && pendingIntel.markers)) {
        return;
      }
      try {
        target.setMarkers([]);
      } catch {
        sessionReady = false;
      }
      pendingIntel.markers = undefined;
    };

    const editor = new editMod.Editor("file", {
      editPrediction: {
        exclude: PREDICTION_EXCLUDE,
        include: PREDICTION_INCLUDE,
        provider: { predict },
      },
      onAttach: (attached) => {
        sessionReady = true;
        paintIntel(attached);
      },
    });

    /** Diagnostics as pierre markers. Markers only exist inside an edit
     * session (`Editor.setMarkers` throws without one), so read-only refs —
     * which deliberately have no session — get hover and go-to-definition but
     * no squiggles; binary and oversize previews have no text to check. */
    const runDiagnostics = async (path: string) => {
      const text = liveText.get(path);
      if (text === undefined || !currentEditable) {
        return;
      }
      intelSeq += 1;
      const seq = intelSeq;
      const diagnostics = await intel.diagnostics(path, text);
      if (
        seq !== intelSeq ||
        aborted() ||
        currentPath !== path ||
        !currentEditable
      ) {
        return;
      }
      pendingIntel.markers = diagnosticsToMarkers(diagnostics, text);
      pendingIntel.path = path;
      paintIntel(editor);
    };

    /** Re-check after an edit settles. */
    const scheduleDiagnostics = () => {
      cancelDiagnostics?.();
      cancelDiagnostics = undefined;
      const path = currentPath;
      if (path === null || !currentEditable || !isScriptFile(path)) {
        return;
      }
      const timer = setTimeout(() => {
        cancelDiagnostics = undefined;
        void runDiagnostics(path);
      }, DIAGNOSTICS_DELAY);
      cancelDiagnostics = () => {
        clearTimeout(timer);
      };
    };

    /** Ask for the caret at a 0-based position (go-to-definition lands here).
     * Placed right away when the session is ready, otherwise by the next
     * attach — a focus request before that is silently dropped by pierre. */
    const placeCaret = (position: IntelPosition) => {
      pendingIntel.caret = position;
      paintIntel(editor);
    };

    // Draft bookkeeping for the pierre editor: clean text clears the draft.
    const handleEditChange = () => {
      if (!currentPath || !currentEditable) {
        return;
      }
      const text = editor.getText();
      liveText.set(currentPath, text);
      const original = originals.get(currentPath) ?? "";
      if (text === original) {
        drafts.delete(currentPath);
      } else {
        drafts.set(currentPath, text);
      }
      pushError = "";
      pushed = null;
      revision += 1;
      syncState();
      scheduleDiagnostics();
    };
    // The token hooks are installed after `openFile` exists (see below): they
    // are the only File options that need to reach back into the pane.
    const fileView = new File({
      onEditChange: handleEditChange,
      overflow: "scroll",
      theme: THEME,
    });
    // Active pierre edit session (dispose before switching files).
    let disposeEdit: (() => void) | undefined;
    let tree: InstanceType<TreesModule["FileTree"]> | undefined;
    onCleanup(() => {
      disposeEdit?.();
      disposeEdit = undefined;
      cancelDiagnostics?.();
      cancelDiagnostics = undefined;
      intel.dispose();
      tip.hide();
      tree?.cleanUp();
      fileView?.cleanUp();
      editor.cleanUp();
    });
    const filePaths = new Set<string>();
    let activePreview = 0;

    // Commit sha of the tree on screen. File contents are addressed by
    // (commit, path), so a cached blob is always right for that commit —
    // reopening a file, or revisiting the page, skips the fetch entirely.
    let treeSha = "";
    const getBlob = async (path: string): Promise<RunnerBlob> => {
      const key = `source:${appId}:blob:${treeSha}:${path}`;
      const hit = treeSha ? readSwr<RunnerBlob>(key) : undefined;
      if (hit) {
        return hit;
      }
      // SAFETY: sourceBlob returns the runner Blob payload which matches RunnerBlob field-for-field; binary/truncated branches are handled by the caller.
      const blob = (await sourceBlob({
        appId,
        path,
        ref: gitRef,
      })) as RunnerBlob;
      if (treeSha) {
        writeSwr(key, blob, { persist: false });
      }
      return blob;
    };

    /** Open `path` in the pane; `caret` lands the cursor there (used by
     * go-to-definition). */
    const openFile = async (path: string, caret?: IntelPosition) => {
      if (aborted()) {
        return;
      }
      if (!filePaths.has(path)) {
        // directory row — nothing to preview
        return;
      }
      activePreview += 1;
      const previewToken = activePreview;
      try {
        const blob = await getBlob(path);
        if (previewToken !== activePreview || aborted()) {
          return;
        }
        currentPath = path;
        // Mirror the open file into the URL (deep-linkable).
        file.set(path);
        // Whatever the previous file reported is now stale: its markers, its
        // hover tip and any check still running. Markers go while the old
        // session is still attached — a disposed session cannot be cleared.
        clearMarkers(editor);
        pendingIntel.caret = undefined;
        pendingIntel.markers = undefined;
        pendingIntel.path = path;
        sessionReady = false;
        intelSeq += 1;
        hoverSeq += 1;
        cancelDiagnostics?.();
        cancelDiagnostics = undefined;
        tip.hide();
        // A new file always starts detached; text re-attaches below.
        disposeEdit?.();
        disposeEdit = undefined;
        if (blob.binary || blob.truncated) {
          // Binary/oversize files stay read-only: no edit session, so
          // no draft can form on placeholder text.
          currentEditable = false;
          liveText.delete(path);
          codeEl.textContent = blob.binary
            ? "(binary file — preview not available)"
            : "(file exceeds 256 KB — preview not available)";
        } else {
          // Only the default branch is editable (no edit session elsewhere →
          // no draft, so a browse of another branch can never commit to main).
          currentEditable = gitRef === base().defaultBranch;
          originals.set(path, blob.text);
          liveText.set(path, drafts.get(path) ?? blob.text);
          // SAFETY: fileView.render expects { file: { name, contents } }; name/value match the opened path/blob text 1:1.
          // Reopening a dirty file restores its draft, not the preview.
          fileView.render({
            containerWrapper: codeEl,
            file: {
              contents: drafts.get(path) ?? blob.text,
              lang: curatedLang(path, diffs.getFiletypeFromFileName),
              name: path,
            },
          });
          if (currentEditable) {
            disposeEdit = editor.edit(fileView);
            if (caret) {
              placeCaret(caret);
            }
          }
          if (isScriptFile(path)) {
            void ensureIntel();
            void runDiagnostics(path);
          }
        }
      } catch (error) {
        if (previewToken === activePreview && !aborted()) {
          codeEl.textContent = errorMessage(error);
        }
      }
    };

    /** Token hooks: pierre reports 1-based lines and per-line characters (its
     * `data-line` / `data-char` attributes), and they keep firing while an edit
     * session is attached — the editor renders the same `data-char` spans the
     * interaction manager resolves, so nothing detaches the hooks. `tokenOffset`
     * turns one into an offset into the file's live text. */
    const tokenOffset = (
      props: TokenEventBase
    ): { offset: number; path: string; text: string } | null => {
      const path = currentPath;
      if (path === null) {
        return null;
      }
      const text = liveText.get(path);
      if (text === undefined || !isScriptFile(path)) {
        return null;
      }
      return {
        offset: offsetAtPosition(text, {
          character: props.lineCharStart,
          line: props.lineNumber - 1,
        }),
        path,
        text,
      };
    };

    const handleTokenEnter = async (props: TokenEventBase) => {
      const hit = tokenOffset(props);
      if (!hit) {
        return;
      }
      hoverSeq += 1;
      const seq = hoverSeq;
      // Ask right away, open only once the pointer has rested: a pass over the
      // code must not flash a tip on every token it crosses.
      const rested = Promise.withResolvers<undefined>();
      setTimeout(() => {
        rested.resolve();
      }, HOVER_DELAY);
      const [info] = await Promise.all([
        intel.quickInfo(hit.path, hit.text, hit.offset),
        rested.promise,
      ]);
      if (seq !== hoverSeq || !info) {
        return;
      }
      await tip.show(
        { code: info.signature, docs: info.docs, lang: "typescript" },
        props.tokenElement
      );
    };

    const handleTokenLeave = () => {
      hoverSeq += 1;
      tip.hide();
    };

    /** Cmd/Ctrl+click: open the definition, or — for a target with no tree row
     * (a `node_modules` declaration, a lib `.d.ts`) — show the declaration
     * around it right where the click happened, read-only. */
    const handleTokenClick = (props: TokenEventBase, event: MouseEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      const hit = tokenOffset(props);
      if (!hit) {
        return;
      }
      void (async () => {
        try {
          const target = await intel.definition(hit.path, hit.text, hit.offset);
          if (!target || aborted()) {
            return;
          }
          if (target.preview) {
            hoverSeq += 1;
            await tip.show(
              {
                code: target.preview.join("\n"),
                docs: [],
                header: `${target.path}:${target.start.line + 1}`,
                lang: curatedLang(target.path, diffs.getFiletypeFromFileName),
              },
              props.tokenElement
            );
            return;
          }
          await openFile(target.path, target.start);
        } catch {
          // Navigation is best-effort: a failed jump must never disturb the
          // pane the user is editing.
        }
      })();
    };

    // `File.setOptions` replaces the whole option set, so the hooks are added
    // to a copy of what the component was built with.
    fileView.setOptions({
      onEditChange: handleEditChange,
      onTokenClick: handleTokenClick,
      onTokenEnter: (props) => {
        void handleTokenEnter(props);
      },
      onTokenLeave: handleTokenLeave,
      overflow: "scroll",
      theme: THEME,
    });

    // Tree snapshot (lib/swr-store): a revisit or reload paints the last
    // tree at once, then revalidates and rebuilds only on a new commit.
    const treeKey = `source:${appId}:tree:${gitRef}`;
    const fetchTree = async (): Promise<TreeData> => {
      const fresh = await sourceTree({ appId, ref: gitRef });
      writeSwr(treeKey, fresh);
      return fresh;
    };

    // Build the file tree from data (snapshot, fresh fetch, post-push).
    // Returns a default file to open, if any.
    const buildTree = (treeData: TreeData): string | undefined => {
      treeSha = treeData.sha;
      filePaths.clear();
      for (const f of treeData.files) {
        filePaths.add(f.path);
      }
      // Deep link wins when it names a real file; otherwise the
      // Worker config is the sensible default to open — and the
      // tree highlights whichever file lands open.
      const urlFile = file();
      const configFile = [
        "cloudflare.config.ts",
        "wrangler.jsonc",
        "wrangler.toml",
      ].find((name) => filePaths.has(name));
      const initial: string | undefined =
        urlFile && filePaths.has(urlFile) ? urlFile : configFile;
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
      tree = new FileTree({
        initialExpandedPaths: ancestors,
        initialSelectedPaths: initial ? [initial] : undefined,
        onSelectionChange: (selected) => {
          if (selected[0]) {
            void openFile(selected[0]);
          }
        },
        preparedInput: preparePresortedFileTreeInput(
          sortTreePaths(treeData.files.map((f) => f.path))
        ),
        search: true,
      });
      tree.render({ fileTreeContainer: treeEl });
      return initial;
    };

    // Commit the drafts and push: to the default branch, or to a new branch
    // started at the default branch's tip.
    const commit: CommitDrafts = async ({ branch, message }) => {
      if (pushing || drafts.size === 0) {
        return false;
      }
      pushing = true;
      pushError = "";
      syncState();
      const files = [...drafts].map(([path, content]) => ({
        content,
        path,
      }));
      try {
        const args: SourceCommitInput = { appId, files, message };
        if (branch !== undefined) {
          args.branch = branch;
          const { mainSha } = base();
          if (mainSha) {
            args.fromSha = mainSha;
          }
        }
        const result = await sourceCommit(args);
        if (!result) {
          throw new Error("commit returned nothing");
        }
        // A push to the default branch makes the drafts its new text; one to
        // a new branch leaves the browsed branch as it was, so the open file
        // goes back to that text.
        if (branch === undefined) {
          for (const [path, content] of drafts) {
            originals.set(path, content);
          }
        }
        drafts.clear();
        revision += 1;
        pushed = {
          branch: branch ?? base().defaultBranch,
          newBranch: branch !== undefined,
        };
        if (intelStarted) {
          // The repo moved: every file that is not the open one now exists at a
          // newer commit, so the worker re-reads the bundle (and re-parses the
          // config) instead of checking against the previous one.
          void intel.reset(loadSources, []);
        }
        const fresh = await fetchTree();
        if (!aborted()) {
          buildTree(fresh);
          if (branch !== undefined && currentPath) {
            await openFile(currentPath);
          }
        }
        return true;
      } catch (error) {
        pushError = errorMessage(error);
        return false;
      } finally {
        pushing = false;
        syncState();
      }
    };
    onCommitReady(commit);
    try {
      const snapshot = readSwr<TreeData>(treeKey);
      // Paint whatever we have first: the stored tree (and its cached
      // default file) needs no network at all.
      if (snapshot) {
        const initial = buildTree(snapshot);
        if (initial) {
          await openFile(initial);
        }
        if (aborted()) {
          return;
        }
      }
      const fresh = await fetchTree();
      if (aborted()) {
        return;
      }
      if (!snapshot || fresh.sha !== snapshot.sha) {
        // Cold, or a push landed since the snapshot: (re)build and reopen.
        const initial = buildTree(fresh);
        if (initial) {
          await openFile(initial);
        }
      }
      syncState();
    } catch (error) {
      treeEl.textContent = "";
      codeEl.textContent = errorMessage(error);
    }
  });

  return (
    <div class="flex min-h-0 w-full flex-1 flex-col gap-2">
      <div class="flex min-h-0 min-w-0 flex-1">
        <div
          ref={attach("tree")}
          class="noite-src-tree bg-base-200/50 border-base-300 min-h-0 w-72 shrink-0 overflow-auto border-r pt-2"
        ></div>
        <div
          ref={attach("code")}
          class="min-h-0 min-w-0 flex-1 overflow-auto"
        ></div>
      </div>
    </div>
  );
};
