//! The source browser: the file tree, the editor pane and the one commit form
//! that ties them together, over the runner's source API and nothing else. An
//! edit is a blob read, a buffer in this page and a `POST`; there is no second
//! origin, no worker and no persistence, so a failure is an HTTP status and a
//! reload is the way back to the commit's text.
//!
//! ## Lifecycles
//!
//! - `./ref-view`: which ref the panes show, which one is opening, and why a
//!   browse failed (one closed type).
//! - `./pane-view`: the open file (one closed type).
//! - `./operations`: the commit, from the button to the outcome line.
//! - The buffers themselves are `./session`'s maps, not a lifecycle.

import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { api } from "../api";
import { commitSource } from "../commit-source";
import { errorMessage } from "../errors";
import { invalidateForge } from "../forge/data";
import { whenFrame, whenLive } from "../live-ref";
import type { LiveRef } from "../live-ref";
import type { RunnerBlob, RunnerTree } from "../runner";
import type { SearchParam } from "../search-param";
import { confirmDialog } from "../ui/confirm";
import type {
  DraftActions,
  PushRequest,
  ReadOnlyRef,
  SourceBrowserState,
} from "./drafts";
import { createEditorPane } from "./editor";
import { READ_ONLY_PUSH } from "./failure-copy";
import { operationFailure, PushOps, settlePush, startPush } from "./operations";
import type { PushOperation } from "./operations";
import { paintSkeleton, paneIn } from "./pane";
import type { DiffsModule, EditModule, TreesModule } from "./pierre";
import {
  failureOf,
  readOnlyOf,
  RefEvents,
  RefViews,
  stepRef,
  switchingTo,
} from "./ref-view";
import type { ReadyCheckout, RefView } from "./ref-view";
import {
  add,
  addUpload,
  changeCount,
  changes,
  commitInput,
  discard,
  discardAll,
  edit,
  emptySession,
  move,
  openSession,
  prime,
  remove,
  restore,
} from "./session";
import type { EditSession, SourceChange, Upload } from "./session";
import { createTreeWiring } from "./tree";
import type { TreeWiring } from "./tree";

/** What the page hands the browser. Values that change per render are atoms or
 * search params; the browser reads them, and reports back through the two
 * callbacks. */
export interface SourceBrowserProps {
  appId: string;
  /** Why a ref opens read-only ("" = editable), asked when one opens. */
  canEditRef: (ref: string) => Promise<ReadOnlyRef>;
  file: SearchParam<string>;
  /** The browsed ref, in step with `?ref=`. */
  gitRef: AtomHandle<string>;
  /** Write a ref to the URL: a commit to another branch moves the browse there,
   * and the page's `?ref=` is what the panes follow. */
  setRef: (ref: string) => void;
  /** The draft verbs, handed over once the browser has them. */
  onDraftsReady: (actions: DraftActions) => void;
  /** Every change of the session, for the page's badge and panel. */
  onState: (state: SourceBrowserState) => void;
  /** A file was opened (a tree pick, an added file): below `lg` the page lets
   * its file tree slide-over go. */
  onFileOpen?: () => void;
  /** The page's tree column: the browser mounts the tree into it. */
  treeHost: LiveRef<HTMLElement>;
}

/** The browser's mutable box: what must outlive re-renders and never enter the
 * SSR snapshot (functions, DOM handles). */
interface BrowserBox {
  changeIndex: Map<string, SourceChange>;
  changeList: readonly SourceChange[];
  /** The installed panes, once `attach` has built them. */
  editor: ReturnType<typeof createEditorPane> | null;
  /** False once the page let the browser go: every pending answer is dropped. */
  live: boolean;
  /** The push in flight or its outcome. */
  pushOp: PushOperation;
  /** Starts one ref's read. Installed by `attach`. */
  request: ((ref: string, force: boolean) => void) | null;
  /** The page's edit session: the browsed tree and every buffer. */
  session: EditSession;
  /** Bumped on every change: a key for views rebuilt from the session. */
  revision: number;
  tree: TreeWiring | null;
  /** Whether the panes are already wired to the document's element. ilha calls
   * a `ref` with detached scratch copies on every re-render, so `attach` only
   * wires the element that is actually in the page, and only once. */
  wired: boolean;
  /** The instance's one cancellation source: every listener and pending answer
   * rides it, and it is aborted when the page lets the browser go. It lives in
   * the box because a render must not replace it — listeners attached with an
   * already-aborted signal are silently dead. */
  dialogs: AbortController;
}

const newBrowserBox = (): BrowserBox => ({
  changeIndex: new Map(),
  changeList: [],
  dialogs: new AbortController(),
  editor: null,
  live: true,
  pushOp: PushOps.Idle(),
  request: null,
  revision: 0,
  session: emptySession(),
  tree: null,
  wired: false,
});

export const SourceBrowser = ({
  appId,
  canEditRef,
  file,
  gitRef,
  onDraftsReady,
  onFileOpen,
  onState,
  setRef,
  treeHost,
}: SourceBrowserProps) => {
  // The box carries the installed request closure (functions do not serialize):
  // out of the SSR snapshot, rebuilt by the client on hydration.
  const box = atom.lazy(newBrowserBox, { snapshot: false })();
  const view = atom<RefView>(RefViews.Booting());
  const notice = atom("");

  const current = (): ReadyCheckout | null => {
    const state = view();

    if (state._tag === "Ready") {
      return state.checkout;
    }

    return state._tag === "Opening" || state._tag === "Failed"
      ? state.previous
      : null;
  };

  const recompute = (): void => {
    box.changeList = changes(box.session);
    box.changeIndex = new Map(box.changeList.map((row) => [row.path, row]));
  };

  /** Report the session and the commit to the page. */
  const syncState = (): void => {
    onState({
      files: box.changeList,
      pushError: box.pushOp._tag === "Failed" ? box.pushOp.failure : null,
      pushed: box.pushOp._tag === "Done" ? box.pushOp.to : null,
      pushing: box.pushOp._tag === "Pushing",
      readOnly: readOnlyOf(view()),
      revision: box.revision,
    });
  };

  /** Install a session's successor and repaint what reads it. */
  const apply = (next: EditSession): void => {
    box.session = next;
    box.revision += 1;
    recompute();
    box.editor?.syncStatus();
    box.tree?.syncStatus();
    syncState();
  };

  /** Every path the tree shows: the commit's files (a staged deletion keeps its
   * row, marked), the session's additions, and the destinations of its moves. */
  const rows = (): string[] => {
    const out: string[] = [];

    for (const path of box.session.base.keys()) {
      if (!box.session.moves.has(path)) {
        out.push(path);
      }
    }

    for (const [path, buffer] of box.session.buffers) {
      if (buffer.base === null) {
        out.push(path);
      }
    }

    for (const to of box.session.moves.keys()) {
      out.push(to);
    }

    return out;
  };

  /** Read one blob at the browsed ref, priming the buffer with the committed
   * text so the first keystroke has a diff base without a second read. */
  const readBlob = async (path: string): Promise<RunnerBlob> => {
    // A file this session added is not in any commit yet: its buffer is the
    // only copy, and the pane shows it without asking the runner (a request
    // for it would be a 404).
    const held = box.session.buffers.get(path);

    if (held !== undefined && held.base === null) {
      return {
        binary: held.upload !== undefined,
        path,
        sha: "",
        size: held.upload?.bytes ?? held.text.length,
        text: held.text,
        truncated: false,
      };
    }

    const checkout = current();

    const blob = await api<RunnerBlob>("/api/source/sourceBlob", {
      appId,
      path,
      ref: checkout?.ref ?? "",
    });

    if (!(blob.binary || blob.truncated)) {
      box.session = prime(box.session, path, blob.text);
      recompute();
    }

    return blob;
  };

  /** The buffer verbs the tree and the panel call: each mutates the session and
   * repaints, and each answers its refusal as text for the toast. */
  const addText = (path: string, text: string): string => {
    const result = add(box.session, path, text);

    if (!result.ok) {
      return result.reason;
    }

    apply(result.session);

    return "";
  };

  const addUploadFile = (path: string, upload: Upload): string => {
    const result = addUpload(box.session, path, upload);

    if (!result.ok) {
      return result.reason;
    }

    apply(result.session);

    return "";
  };

  const movePath = (from: string, to: string): string => {
    const result = move(box.session, from, to);

    if (!result.ok) {
      return result.reason;
    }

    apply(result.session);

    return "";
  };

  /** Install a ref's checkout: the session is the new tree, the panes show it,
   * and the deep link's file (or the repository's front door) opens. */
  const install = async (checkout: ReadyCheckout): Promise<void> => {
    const decision = stepRef(view(), RefEvents.Opened({ checkout }));

    if (decision.refused) {
      return;
    }

    view.set(decision.state);
    box.session = openSession(checkout.tree);
    box.revision += 1;
    recompute();
    box.editor?.drop();
    // Exactly one of the two outcomes the browse has: the file the checkout
    // opens (the URL's, or the repository's front door) or a checkout with no
    // files at all. The pane machine paints the second, not this function.
    const chosen = box.tree?.build();
    syncState();

    if (chosen === undefined) {
      return;
    }

    if (chosen._tag === "Empty") {
      box.editor?.empty();

      return;
    }

    await box.editor?.open(chosen.path);
  };

  /** Start one ref's read. A stale answer is dropped by the ref machine (it
   * refuses an `Opened` for a ref it is not opening), never by a "still
   * mounted" flag. */
  const requestRef = (ref: string, force: boolean): void => {
    const decision = stepRef(view(), RefEvents.Requested({ force, ref }));

    if (decision.refused || decision.read === "") {
      return;
    }

    view.set(decision.state);

    void (async () => {
      try {
        const listing = await api<RunnerTree>("/api/source/sourceTree", {
          appId,
          ref: decision.read,
        });

        const readOnly = await canEditRef(decision.read);

        if (box.live) {
          await install({ readOnly, ref: decision.read, tree: listing });
        }
      } catch (error) {
        const failed = stepRef(
          view(),
          RefEvents.Failed({ message: errorMessage(error), ref: decision.read })
        );

        if (!failed.refused && box.live) {
          view.set(failed.state);
        }
      }
    })();
  };

  /** The commit: one body, one request, one outcome. */
  const commit = async (request: PushRequest): Promise<boolean> => {
    const checkout = current();

    const started = startPush(
      box.pushOp,
      request.branch ?? checkout?.ref ?? ""
    );

    if (checkout === null || started === null) {
      return false;
    }

    const input = commitInput(box.session);

    if (
      input.files.length === 0 &&
      input.deletes.length === 0 &&
      input.moves.length === 0
    ) {
      return false;
    }

    box.pushOp = started;
    syncState();

    // The commit names the branch it lands on. The runner's own default is the
    // default branch, which is not necessarily the one being browsed, so the
    // target is always sent; a branch this commit creates starts at the
    // browsed commit (`fromSha`), and an existing one grows from its own tip
    // (the runner ignores `fromSha` then).
    const target = request.branch ?? checkout.ref;

    const createsBranch = request.branch !== undefined;

    const where = createsBranch
      ? { branch: target, fromSha: checkout.tree.sha }
      : { branch: target };

    try {
      await commitSource({
        appId,
        ...input,
        ...where,
        message: request.message,
      });
      box.pushOp = settlePush(box.pushOp, {
        ok: true,
        to: {
          base: checkout.ref,
          branch: target,
          newBranch: request.create === true,
        },
      });
      // The commit owns the bytes now: the buffers are gone, and the rows come
      // back from the branch's new tip (which is how a move and a delete land).
      box.editor?.drop();
      invalidateForge(appId);
      apply(discardAll(box.session));

      // The URL is the browsed ref: committing to another branch (a new one,
      // or a target picked in the form) moves it there, and the watch below
      // installs it. The same branch only needs its new tip read.
      if (target === checkout.ref) {
        requestRef(target, true);
      } else {
        setRef(target);
      }
    } catch (error) {
      box.pushOp = settlePush(box.pushOp, {
        failure: operationFailure(error),
        ok: false,
      });
    }

    syncState();

    return box.pushOp._tag === "Done";
  };

  const drafts: DraftActions = {
    commit,
    discard: (path) => {
      apply(discard(box.session, path));
    },
    discardAll: () => {
      apply(discardAll(box.session));
    },
    restore: (path) => {
      apply(restore(box.session, path));
    },
  };

  /** A ref switch with unsaved work asks first: the buffers belong to the ref
   * they were edited on, and there is nowhere to keep them. */
  const askSwitch = async (next: string): Promise<boolean> => {
    const count = changeCount(box.session);

    const ok = await confirmDialog({
      confirmLabel: "Discard and switch",
      message: `${count} unsaved ${count === 1 ? "change goes" : "changes go"} away. Commit them first to keep them.`,
      signal: box.dialogs.signal,
      title: `Switch to ${next}?`,
    });

    return ok === "confirm";
  };

  /** Paint the shell and wire the panes: one mount per page visit. */
  const attach = (host: HTMLElement | null) => {
    if (host === null || box.wired) {
      return;
    }

    void (async () => {
      // A first mount calls `ref` before insertion, and every later render
      // calls it with a detached scratch copy: wait for the one element that
      // is in the document, then wire it once.
      const codeHost = await whenFrame(
        () => (host.isConnected ? host : null),
        box.dialogs.signal
      );

      const treeEl = await whenLive(treeHost, box.dialogs.signal);

      if (codeHost === null || treeEl === null || !box.live) {
        return;
      }

      box.wired = true;
      const body = paneIn(codeHost);

      paintSkeleton(treeEl, "tree", "Loading files…");
      paintSkeleton(body, "code", "Loading files…");

      const [diffs, editModule, treesModule] = await Promise.all([
        import("@pierre/diffs"),
        import("@pierre/diffs/edit"),
        import("@pierre/trees"),
      ]);

      if (!box.live) {
        return;
      }

      // SAFETY: import() resolves the installed @pierre modules, which
      // structurally match DiffsModule/EditModule/TreesModule (the minimal
      // interfaces in `./pierre` exist because the vendor types are wider).
      /* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- vendor classes carry generics the local interfaces never need; the SAFETY note above covers all three */
      const diffsModule = diffs as unknown as DiffsModule;
      const editModuleTyped = editModule as unknown as EditModule;
      const treesTyped = treesModule as unknown as TreesModule;
      /* oxlint-enable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */

      box.editor = createEditorPane({
        aborted: () => !box.live,
        changeAt: (path) => box.changeIndex.get(path)?.kind ?? null,
        codeEl: body,
        diffs: diffsModule,
        edit: editModuleTyped,
        editable: () => readOnlyOf(view()) === "",
        file,
        held: (path) => box.session.buffers.get(path)?.text ?? null,
        onEdit: (path, text) => {
          apply(edit(box.session, path, text, null));
        },
        read: readBlob,
      });

      box.tree = createTreeWiring({
        aborted: () => !box.live,
        addText,
        addUpload: addUploadFile,
        changeAt: (path) => box.changeIndex.get(path),
        editable: () => readOnlyOf(view()) === "",
        file,
        movePath,
        notify: (message) => {
          notice.set(message);
        },
        openFile: async (path) => {
          const opened = (await box.editor?.open(path)) ?? false;

          if (opened) {
            onFileOpen?.();
          }

          return opened;
        },
        removePath: (path) => {
          apply(remove(box.session, path));
        },
        rows,
        signal: box.dialogs.signal,
        treeEl,
        trees: treesTyped,
      });

      onDraftsReady(drafts);
      box.request = requestRef;
      requestRef(gitRef(), false);
    })();
  };

  watch(gitRef, (next) => {
    if (box.request === null || next === current()?.ref) {
      return;
    }

    if (changeCount(box.session) === 0) {
      box.request(next, false);

      return;
    }

    void (async () => {
      if (await askSwitch(next)) {
        box.request?.(next, true);

        return;
      }

      // Put the picker back where the panes are.
      const shown = current();

      if (shown !== null) {
        setRef(shown.ref);
      }
    })();
  });

  /** A page going away with unsaved work warns: there is no persistence to
   * come back to. */
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (changeCount(box.session) === 0) {
      return;
    }

    event.preventDefault();
  };

  watch.once(({ onCleanup }) => {
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", onBeforeUnload);
    }

    onCleanup(() => {
      box.live = false;
      box.dialogs.abort();
      box.tree?.cleanUp();
      box.editor?.cleanUp();

      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", onBeforeUnload);
      }
    });
  });

  const readOnlyRef = readOnlyOf(view());
  const readOnlyNow = readOnlyRef === "" ? "" : READ_ONLY_PUSH[readOnlyRef];
  const failed = failureOf(view());
  const switchingNow = switchingTo(view());

  return (
    <div class="contents">
      <div
        data-slot="resizable-panel"
        data-morph-preserve="true"
        class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {readOnlyNow === "" ? null : (
          <p
            class="bg-base-300/60 text-base-content border-base-300 m-0 border-b px-3 py-1.5 text-xs"
            role="status"
          >
            {readOnlyNow}
          </p>
        )}
        {notice() === "" ? null : (
          <p
            class="bg-warning/20 text-base-content border-base-300 m-0 border-b px-3 py-2 text-xs"
            role="status"
          >
            {notice()}
          </p>
        )}
        <div ref={attach} class="min-h-0 min-w-0 flex-1 overflow-auto"></div>
      </div>
      {switchingNow === "" ? null : (
        <div
          class="absolute inset-0 z-20 cursor-progress"
          role="status"
          data-source-switch={switchingNow}
        >
          <div class="rounded-box border-base-300 bg-base-100/95 absolute top-2 right-2 flex items-center gap-2 border px-2.5 py-1.5 text-xs shadow-lg">
            <span class="loading loading-spinner loading-xs"></span>
            <span>
              Switching to <span class="font-mono">{switchingNow}</span>…
            </span>
          </div>
        </div>
      )}
      {failed === null ? null : (
        <div
          class="bg-base-100/85 absolute inset-0 z-30 flex items-center justify-center p-6"
          role="alert"
        >
          <div class="rounded-box border-base-300 bg-base-100 flex max-w-md flex-col items-start gap-3 border p-4 shadow-lg">
            <p class="m-0 text-sm">
              Could not open <span class="font-mono">{failed.ref}</span>:{" "}
              {failed.message}
            </p>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              onclick={() => {
                box.request?.(failed.ref, true);
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
