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
import { whenLive } from "../live-ref";
import type { LiveRef } from "../live-ref";
import type { RunnerBlob, RunnerTree } from "../runner";
import type { SearchParam } from "../search-param";
import { confirmDialog } from "../ui/confirm";
import type { DraftActions, ReadOnlyRef, SourceBrowserState } from "./drafts";
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
  /** The draft verbs, handed over once the browser has them. */
  onDraftsReady: (actions: DraftActions) => void;
  /** Every change of the session, for the page's badge and panel. */
  onState: (state: SourceBrowserState) => void;
  /** The page's tree column: the browser mounts the tree into it. */
  treeHost: LiveRef<HTMLElement>;
}

/** The browser's mutable box: what must outlive re-renders and never enter the
 * SSR snapshot (functions, DOM handles). */
interface BrowserBox {
  /** False once the page let the browser go: every pending answer is dropped. */
  live: boolean;
  /** Starts one ref's read. Installed by `attach`. */
  request: ((ref: string, force: boolean) => void) | null;
}

const newBrowserBox = (): BrowserBox => ({ live: true, request: null });

export const SourceBrowser = ({
  appId,
  canEditRef,
  file,
  gitRef,
  onDraftsReady,
  onState,
  treeHost,
}: SourceBrowserProps) => {
  // The box carries the installed request closure (functions do not serialize):
  // out of the SSR snapshot, rebuilt by the client on hydration.
  const box = atom.lazy(newBrowserBox, { snapshot: false })();
  const view = atom<RefView>(RefViews.Booting());
  const notice = atom("");

  let session: EditSession = emptySession();
  let changeList: readonly SourceChange[] = [];
  let changeIndex = new Map<string, SourceChange>();
  let revision = 0;
  let pushOp: PushOperation = PushOps.Idle();
  let editor: ReturnType<typeof createEditorPane> | null = null;
  let tree: TreeWiring | null = null;
  const dialogs = new AbortController();

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
    changeList = changes(session);
    changeIndex = new Map(changeList.map((row) => [row.path, row]));
  };

  /** Report the session and the commit to the page. */
  const syncState = (): void => {
    onState({
      files: changeList,
      pushError: pushOp._tag === "Failed" ? pushOp.failure : null,
      pushed: pushOp._tag === "Done" ? pushOp.to : null,
      pushing: pushOp._tag === "Pushing",
      readOnly: readOnlyOf(view()),
      revision,
    });
  };

  /** Install a session's successor and repaint what reads it. */
  const apply = (next: EditSession): void => {
    session = next;
    revision += 1;
    recompute();
    editor?.syncStatus();
    tree?.syncStatus();
    syncState();
  };

  /** Every path the tree shows: the commit's files (a staged deletion keeps its
   * row, marked), the session's additions, and the destinations of its moves. */
  const rows = (): string[] => {
    const out: string[] = [];

    for (const path of session.base.keys()) {
      if (!session.moves.has(path)) {
        out.push(path);
      }
    }

    for (const [path, buffer] of session.buffers) {
      if (buffer.base === null) {
        out.push(path);
      }
    }

    for (const to of session.moves.keys()) {
      out.push(to);
    }

    return out;
  };

  /** Read one blob at the browsed ref, priming the buffer with the committed
   * text so the first keystroke has a diff base without a second read. */
  const readBlob = async (path: string): Promise<RunnerBlob> => {
    const checkout = current();

    const blob = await api<RunnerBlob>("/api/source/sourceBlob", {
      appId,
      path,
      ref: checkout?.ref ?? "",
    });

    if (!(blob.binary || blob.truncated)) {
      session = prime(session, path, blob.text);
      recompute();
    }

    return blob;
  };

  /** The buffer verbs the tree and the panel call: each mutates the session and
   * repaints, and each answers its refusal as text for the toast. */
  const addText = (path: string, text: string): string => {
    const result = add(session, path, text);

    if (!result.ok) {
      return result.reason;
    }

    apply(result.session);

    return "";
  };

  const addUploadFile = (path: string, upload: Upload): string => {
    const result = addUpload(session, path, upload);

    if (!result.ok) {
      return result.reason;
    }

    apply(result.session);

    return "";
  };

  const movePath = (from: string, to: string): string => {
    const result = move(session, from, to);

    if (!result.ok) {
      return result.reason;
    }

    apply(result.session);

    return "";
  };

  /** Install a ref's checkout: the session is the new tree, the panes show it,
   * and the deep link's file (or the Worker config) opens. */
  const install = async (checkout: ReadyCheckout): Promise<void> => {
    const decision = stepRef(view(), RefEvents.Opened({ checkout }));

    if (decision.refused) {
      return;
    }

    view.set(decision.state);
    session = openSession(checkout.tree);
    revision += 1;
    recompute();
    editor?.drop();
    const initial = tree?.build();
    syncState();

    if (initial !== undefined) {
      await editor?.open(initial);

      return;
    }

    editor?.note("This repository has no files yet");
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
  const commit = async (request: {
    branch?: string;
    message: string;
  }): Promise<boolean> => {
    const checkout = current();
    const started = startPush(pushOp, request.branch ?? checkout?.ref ?? "");

    if (checkout === null || started === null) {
      return false;
    }

    const input = commitInput(session);

    if (
      input.files.length === 0 &&
      input.deletes.length === 0 &&
      input.moves.length === 0
    ) {
      return false;
    }

    pushOp = started;
    syncState();

    // The commit names the branch it lands on; the runner creates a new one at
    // the browsed tip and grows an existing one from its own tip.
    const target = request.branch ?? checkout.ref;
    const where = request.branch === undefined ? {} : { branch: target };

    try {
      await commitSource({
        appId,
        ...input,
        ...where,
        message: request.message,
      });
      pushOp = settlePush(pushOp, {
        ok: true,
        to: { branch: target, newBranch: request.branch !== undefined },
      });
      // The commit owns the bytes now: the buffers are gone, and the rows come
      // back from the branch's new tip (which is how a move and a delete land).
      editor?.drop();
      invalidateForge(appId);
      apply(discardAll(session));
      requestRef(target, true);
    } catch (error) {
      pushOp = settlePush(pushOp, {
        failure: operationFailure(error),
        ok: false,
      });
    }

    syncState();

    return pushOp._tag === "Done";
  };

  const drafts: DraftActions = {
    commit,
    discard: (path) => {
      apply(discard(session, path));
    },
    discardAll: () => {
      apply(discardAll(session));
    },
    restore: (path) => {
      apply(restore(session, path));
    },
  };

  /** A ref switch with unsaved work asks first: the buffers belong to the ref
   * they were edited on, and there is nowhere to keep them. */
  const askSwitch = async (next: string): Promise<boolean> => {
    const count = changeCount(session);

    const ok = await confirmDialog({
      confirmLabel: "Discard and switch",
      message: `${count} unsaved ${count === 1 ? "change goes" : "changes go"} away. Commit them first to keep them.`,
      signal: dialogs.signal,
      title: `Switch to ${next}?`,
    });

    return ok === "confirm";
  };

  /** Paint the shell and wire the panes: one mount per page visit. */
  const attach = (codeHost: HTMLElement | null) => {
    if (codeHost === null) {
      return;
    }

    const body = paneIn(codeHost);

    void (async () => {
      const treeEl = await whenLive(treeHost, dialogs.signal);

      if (treeEl === null || !box.live) {
        return;
      }

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

      editor = createEditorPane({
        aborted: () => !box.live,
        changeAt: (path) => changeIndex.get(path)?.kind ?? null,
        codeEl: body,
        diffs: diffsModule,
        edit: editModuleTyped,
        editable: () => readOnlyOf(view()) === "",
        file,
        held: (path) => session.buffers.get(path)?.text ?? null,
        onEdit: (path, text) => {
          apply(edit(session, path, text, null));
        },
        read: readBlob,
      });

      tree = createTreeWiring({
        aborted: () => !box.live,
        addText,
        addUpload: addUploadFile,
        changeAt: (path) => changeIndex.get(path),
        editable: () => readOnlyOf(view()) === "",
        file,
        movePath,
        notify: (message) => {
          notice.set(message);
        },
        openFile: async (path) => (await editor?.open(path)) ?? false,
        removePath: (path) => {
          apply(remove(session, path));
        },
        rows,
        signal: dialogs.signal,
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

    if (changeCount(session) === 0) {
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
        gitRef.set(shown.ref);
      }
    })();
  });

  /** A page going away with unsaved work warns: there is no persistence to
   * come back to. */
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (changeCount(session) === 0) {
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
      dialogs.abort();
      tree?.cleanUp();
      editor?.cleanUp();

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
