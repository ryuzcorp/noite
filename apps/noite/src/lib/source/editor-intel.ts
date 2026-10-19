//! The source pane's TypeScript intelligence: the language-service worker
//! (`SourceIntel`) and the sources it compiles, the diagnostics it reports as
//! pierre markers, the hover tip with the token hooks that drive it, and the
//! caret placement go-to-definition lands on. It reads the pane's open-file
//! state through `host` and writes markers back to the editor pierre attaches
//! — the pane builds that editor, so it can only hand it over at the attach.

import type { TokenEventBase } from "@pierre/diffs";
import type {
  EditPredictContext,
  EditPredictRequest,
  EditPredictResponse,
  Marker,
  Position,
} from "@pierre/diffs/edit";

import { api } from "../api";
import type { RunnerSourceBundle } from "../runner";
import { curatedLang } from "../shiki-langs";
import { HOVER_DELAY, createHoverTip } from "./hover-tip";
import { SourceIntel } from "./intel";
import {
  completionRemainder,
  diagnosticMessagesAtOffset,
  diagnosticsToMarkers,
  isScriptFile,
  lineStarts,
  offsetAtPosition,
  positionAtOffset,
  supportsPrediction,
} from "./intel-protocol";
import type {
  IntelBundle,
  IntelDiagnostic,
  IntelFile,
  IntelPosition,
} from "./intel-protocol";
import type { DiffsModule, MarkerTarget } from "./pierre";
import type { WorkspaceChange } from "./workspace/types";

/** Diagnostics re-run this long after the last keystroke (a full program check
 * per keystroke would fight the user's typing). */
const DIAGNOSTICS_DELAY = 400;

/** Work the current file computed before its edit session could take it. The
 * session is only marker-ready (and only focusable) after the editor reports
 * the attach, so what is computed earlier is parked here and painted then. */
interface PendingIntel {
  caret?: IntelPosition;
  markers?: Marker[];
  path?: string;
}

/** What the intelligence layer reads from the pane: the open file and its live
 * text, the workspace's changes and the ref the worker's sources are fetched
 * for. */
export interface EditorIntelHost {
  aborted: () => boolean;
  appId: string;
  /** The workspace's changes, as of the last derive: the texts that are the
   * worker's own copy of a file the commit does not have. */
  changes: () => readonly WorkspaceChange[];
  codeEl: HTMLElement;
  /** Whether the open file has an edit session (see the pane's `paint`). */
  currentEditable: () => boolean;
  currentPath: () => string | null;
  diffs: DiffsModule;
  /** The ref the worker's sources are fetched for: read, never captured, so a
   * branch switch re-reads them for the ref the pane now browses. */
  gitRef: () => string;
  /** Live text per open path: the pane's own map, kept current by every edit. */
  liveText: Map<string, string>;
}

/** Where a go-to-definition jump lands: the pane's `openFile`, which cannot be
 * bound when this layer is built (the editor it paints through is built after
 * it), so the pierre hook that triggers the jump passes it over. The answer
 * says whether the pane landed on the file at all. */
export type NavigateTo = (
  path: string,
  caret: IntelPosition
) => Promise<boolean>;

/** The intelligence layer's surface for the pane. */
export interface EditorIntel {
  /** A file switch: the previous file's markers go while its session is still
   * attached, the tip hides, and every check in flight is invalidated. */
  beginPreview: (path: string) => void;
  /** The edit session is gone (the pane closed its file): what is parked waits
   * for the next attach. */
  detachSession: () => void;
  /** Drop the pending diagnostics and the intel worker. */
  dispose: () => void;
  /** Start (or join) the language-service worker, with the drafts as they
   * stand. */
  ensure: () => Promise<void>;
  /** Pierre's attach signal: the session is marker-ready (and focusable). */
  onAttach: (attached: MarkerTarget) => void;
  /** Ask for the caret at a 0-based position (go-to-definition lands here). */
  placeCaret: (position: IntelPosition) => void;
  /** Inline prediction: the completion TypeScript ranks first, inserted as
   * ghost text. */
  predict: (
    request: EditPredictRequest,
    context: EditPredictContext
  ) => Promise<EditPredictResponse>;
  /** Re-sync the worker from scratch (a push changed the repo). */
  reset: () => void;
  /** Check `path` right now (the file-open path). */
  runDiagnostics: (path: string) => Promise<void>;
  /** Re-check after an edit settles. */
  scheduleDiagnostics: () => void;
  /** Whether the worker was ever started. */
  started: () => boolean;
  /** Cmd/Ctrl+click: open the definition through `navigate`, or — for a target
   * with no tree row — show its declaration right where the click happened. */
  tokenClick: (
    props: TokenEventBase,
    event: MouseEvent,
    navigate: NavigateTo
  ) => void;
  /** The pointer entered a token: its quick info and diagnostics ride one
   * tip. */
  tokenEnter: (props: TokenEventBase) => Promise<void>;
  tokenLeave: () => void;
}

export const createEditorIntel = (host: EditorIntelHost): EditorIntel => {
  const { diffs, liveText } = host;
  // The declarations the worker fetches from esm.sh land after the first reply
  // the pane painted: re-check the open file then, so what it showed before
  // them stops reading as a missing module.
  // oxlint-disable-next-line eslint/no-use-before-define -- `scheduleDiagnostics` is defined below, after the layers that call it; the worker's event cannot arrive before this returns.
  const intel = new SourceIntel(() => scheduleDiagnostics());
  // The tip hangs in the pane, beside the body the pane paints its files,
  // placeholders and notes into: a paint that wipes the body must not take the
  // tip with it (see `pane.ts`).
  const tip = createHoverTip(host.codeEl.parentElement ?? host.codeEl);
  /** The editor pierre attached to the open file, the only marker target there
   * is: `onAttach` hands back the instance the pane built, so this is the
   * pane's own editor, known only once the session is ready. */
  let sessionTarget: MarkerTarget | undefined;
  /** Only the newest diagnostics run may write markers: a file switch, an
   * edit or a push invalidates whatever is in flight. */
  let intelSeq = 0;
  /** Hover answers arrive out of order too (`quickInfo` is async): only the
   * newest one, for the token the pointer is still on, may open the tip. */
  let hoverSeq = 0;
  /** Diagnostics from the open file's last check, for the hover stack. */
  let currentDiagnostics: readonly IntelDiagnostic[] = [];
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

  /** The server payload — the ref's own text sources — for the revision this
   * layer is on. One multi-megabyte transfer, so it is fetched once and shared
   * by every sync. A push drops it (the repo moved under the worker), and so
   * does a failed fetch, so opening a file retries. */
  let serverBundle: Promise<IntelBundle> | undefined;
  const fetchServerBundle = async (): Promise<IntelBundle> => {
    const fetched = serverBundle;
    if (fetched !== undefined) {
      return await fetched;
    }
    const loading = api<RunnerSourceBundle>("/api/source/sourceBundle", {
      appId: host.appId,
      ref: host.gitRef(),
    });
    serverBundle = loading;
    try {
      return await loading;
    } catch (error) {
      serverBundle = undefined;
      throw error;
    }
  };

  /** The changed files the worker compiles instead of the commit's copy: a
   * deleted path is not in the pod at all, and a binary one has no text. */
  const workerDrafts = (): IntelFile[] =>
    host
      .changes()
      .filter(
        (change) => change.kind !== "deleted" && change.binary === undefined
      )
      .map((change) => ({ path: change.path, text: change.after }));

  /** Start (or join) the language-service worker, with the changed text files
   * as the copy of the program the commit does not have. Memoized inside
   * `SourceIntel`; the package declarations the worker fetches from esm.sh
   * arrive later, as a `typesChanged` event. */
  const ensureIntel = (): Promise<void> => {
    intelStarted = true;
    return intel.sync(fetchServerBundle, workerDrafts());
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
      !host.currentEditable() ||
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
      newCursor: positionAtOffset(lineStarts(text), offset + remainder.length),
    };
  };

  /** Write what the current file parked onto the attached session — markers
   * now that it can take them, and a caret that was asked for while it could
   * not. Best-effort throughout: a stale session is skipped, never
   * escalated. */
  const paintIntel = () => {
    const target = sessionTarget;
    if (
      target === undefined ||
      !sessionReady ||
      pendingIntel.path !== host.currentPath()
    ) {
      return;
    }
    if (pendingIntel.markers && host.currentEditable()) {
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
        target.setSelections([{ direction: "none", end: caret, start: caret }]);
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
  const clearMarkers = () => {
    const target = sessionTarget;
    if (target === undefined || !(sessionReady && pendingIntel.markers)) {
      return;
    }
    try {
      target.setMarkers([]);
    } catch {
      sessionReady = false;
    }
    pendingIntel.markers = undefined;
  };

  /** Diagnostics as pierre markers. Markers only exist inside an edit
   * session (`Editor.setMarkers` throws without one), so read-only refs —
   * which deliberately have no session — get hover and go-to-definition but
   * no squiggles; binary and oversize previews have no text to check. */
  const runDiagnostics = async (path: string) => {
    const text = liveText.get(path);
    if (text === undefined || !host.currentEditable()) {
      return;
    }
    intelSeq += 1;
    const seq = intelSeq;
    const diagnostics = await intel.diagnostics(path, text);
    if (
      seq !== intelSeq ||
      host.aborted() ||
      host.currentPath() !== path ||
      !host.currentEditable()
    ) {
      return;
    }
    currentDiagnostics = diagnostics;
    pendingIntel.markers = diagnosticsToMarkers(diagnostics, text);
    pendingIntel.path = path;
    paintIntel();
  };

  /** Re-check after an edit settles. */
  const scheduleDiagnostics = () => {
    cancelDiagnostics?.();
    cancelDiagnostics = undefined;
    const path = host.currentPath();
    if (path === null || !host.currentEditable() || !isScriptFile(path)) {
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
    paintIntel();
  };

  /** Pierre's attach: the session is ready, and what the file-open path parked
   * can be painted onto it. */
  const onAttach = (attached: MarkerTarget) => {
    sessionTarget = attached;
    sessionReady = true;
    paintIntel();
  };

  /** Token hooks: pierre reports 1-based lines and per-line characters (its
   * `data-line` / `data-char` attributes), and they keep firing while an edit
   * session is attached — the editor renders the same `data-char` spans the
   * interaction manager resolves, so nothing detaches the hooks. `tokenOffset`
   * turns one into an offset into the file's live text. */
  const tokenOffset = (
    props: TokenEventBase
  ): { offset: number; path: string; text: string } | null => {
    const path = host.currentPath();
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

  const tokenEnter = async (props: TokenEventBase) => {
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
    if (seq !== hoverSeq) {
      return;
    }
    // The token's diagnostics ride the same tip: type first, then the errors
    // under a divider. Either one alone still opens the tip.
    const errors = diagnosticMessagesAtOffset(currentDiagnostics, hit.offset);
    if (!info && errors.length === 0) {
      return;
    }
    await tip.show(
      {
        code: info?.signature ?? "",
        docs: info?.docs ?? [],
        errors,
        lang: "typescript",
      },
      props.tokenElement
    );
  };

  /** Leaving the token closes the tip after a grace period, so the pointer
   * can move onto it (`HoverTip.leave`). */
  const tokenLeave = () => {
    hoverSeq += 1;
    tip.leave();
  };

  /** Cmd/Ctrl+click: open the definition, or — for a target with no tree row
   * (a `node_modules` declaration, a lib `.d.ts`) — show the declaration
   * around it right where the click happened, read-only. */
  const tokenClick = (
    props: TokenEventBase,
    event: MouseEvent,
    navigate: NavigateTo
  ) => {
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
        if (!target || host.aborted()) {
          return;
        }
        if (target.preview) {
          hoverSeq += 1;
          await tip.show(
            {
              code: target.preview.join("\n"),
              docs: [],
              errors: [],
              header: `${target.path}:${target.start.line + 1}`,
              lang: curatedLang(target.path, diffs.getFiletypeFromFileName),
            },
            props.tokenElement
          );
          return;
        }
        await navigate(target.path, target.start);
      } catch {
        // Navigation is best-effort: a failed jump must never disturb the
        // pane the user is editing.
      }
    })();
  };

  /** What opening a file starts from: the previous file's markers, hover tip
   * and any check still running are stale from here on. Markers go while the
   * old session is still attached — a disposed session cannot be cleared. A
   * caret asked for this same file is still wanted: a file being opened can be
   * painted more than once (the tree's selection follows the open, an add's
   * row lands twice), and dropping it would leave the pane unfocused. */
  const beginPreview = (path: string) => {
    clearMarkers();
    if (pendingIntel.path !== path) {
      pendingIntel.caret = undefined;
    }
    pendingIntel.markers = undefined;
    pendingIntel.path = path;
    sessionReady = false;
    intelSeq += 1;
    currentDiagnostics = [];
    hoverSeq += 1;
    cancelDiagnostics?.();
    cancelDiagnostics = undefined;
    tip.hide();
  };

  /** The pane closed its file: nothing may write markers until the next
   * attach. */
  const detachSession = () => {
    sessionReady = false;
  };

  const reset = () => {
    // The repo moved: the ref's sources (and with them the lockfile the
    // declarations were pinned to) are whatever the push left, so the memo goes
    // with the worker.
    serverBundle = undefined;
    void intel.reset(fetchServerBundle, workerDrafts());
  };

  const dispose = () => {
    cancelDiagnostics?.();
    cancelDiagnostics = undefined;
    intel.dispose();
    tip.dispose();
  };

  return {
    beginPreview,
    detachSession,
    dispose,
    ensure: ensureIntel,
    onAttach,
    placeCaret,
    predict,
    reset,
    runDiagnostics,
    scheduleDiagnostics,
    started: () => intelStarted,
    tokenClick,
    tokenEnter,
    tokenLeave,
  };
};
