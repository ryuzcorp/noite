/**
 * Source browser: file tree (@pierre/trees) + code preview and editor
 * (@pierre/diffs), both mounted imperatively from their vanilla APIs.
 *
 * The two pane hosts use `ref` callbacks; setup runs once in
 * `watch.once(async ({ signal, onCleanup }) => …)` (client-only, once per
 * mount) and aborts via `signal` on unmount. Change/push state flows back
 * through `onState`, and the row actions through `onDraftsReady`.
 *
 * Data comes from the pod, which lives in a document on the app's preview
 * origin: `openSourceWorkspace` (`./workspace/proxy`) frames it, hands it the
 * ref's listing (`sourceTree` names the commit and its blobs) and answers its
 * archive ask with the tar the control's own session fetched, and every read
 * and write in the panes goes over that RPC — the browser never sees tokens,
 * nothing app-controlled runs on this origin, and there is no draft store
 * beside it.
 *
 * The pane also speaks TypeScript: `SourceIntel` (./intel) drives a lazily
 * created language-service worker that gets the repo's sources, the build's
 * captured declarations and the workspace's changed files, and answers
 * diagnostics (pierre markers), hover, go-to-definition and inline prediction.
 * Everything the compiler needs stays in that worker — the main bundle never
 * imports it.
 *
 * This file is composition only: it loads the vendor modules, opens the
 * workspace, mounts the tree and editor panes (`./tree`, `./editor`) over it,
 * and drives the push.
 */
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { commitSource } from "../commit-source";
import type { SourceCommitInput } from "../commit-source";
import { errorMessage } from "../errors";
import { collectRef, newLiveRef, whenLive } from "../live-ref";
import type { LiveRef } from "../live-ref";
import type { SearchParam } from "../search-param";
import { sourceTree } from "../server/source.server";
import { fetchSourceArchive } from "../source-archive";
import { SquareTerminal } from "../ui/icons";
import type {
  CommitDrafts,
  DraftActions,
  PushedTo,
  SourceBrowserState,
} from "./drafts";
import { createEditorPane } from "./editor";
import { paintSkeleton, paneIn } from "./pane";
import type { DiffsModule, EditModule, TreesModule } from "./pierre";
import type { PreviewLink } from "./preview-session";
import type { TerminalLink } from "./terminal-session";
import { createTreeWiring } from "./tree";
import { base64Bytes, checkLimits, UPLOAD_LIMITS } from "./uploads";
import { openSourceWorkspace } from "./workspace/proxy";
import { PROJECT_ROOT } from "./workspace/types";
import type { Workspace, WorkspaceChange } from "./workspace/types";

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
  /** Called once per mount with what the page's panels may ask the drafts. */
  onDraftsReady: (actions: DraftActions) => void;
  /** The Preview panel, when the page has one: the pod boots with its options
   * and the panel is handed the checkout it previews. */
  preview: PreviewLink;
  /** The terminal panel's session: the shell runs on the checkout this
   * browser opens, and goes away with it. */
  terminal: TerminalLink;
  /** `?terminal=`: the tree column's toggle reads and writes it directly (a
   * handle read subscribes the reading component — see search-param.ts — so
   * the toggle repaints through navigations the keyed browser never does). */
  terminalParam: SearchParam<string>;
}

/** How long a burst of pod-side filesystem events settles before the rows
 * follow it: one resync per burst, never one per write. */
const STRUCTURAL_DEBOUNCE_MS = 150;

/** What the panes' skeletons announce while the checkout opens, and what the
 * code pane says when the checkout opened but no file is on show: the file the
 * browse named (or a config file) does not exist, or the branch holds nothing
 * at all. */
const OPENING_NOTE = "Opening checkout…";
const SELECT_FILE_NOTE = "Select a file to view";
const NO_FILES_NOTE = "This repository has no files yet";

/** The tree column's footer: toggles `?terminal=1`, styled like the Code mode
 * bar's panel toggles. */
const TerminalToggle = ({ param }: { param: SearchParam<string> }) => {
  const open = param() === "1";
  return (
    <button
      type="button"
      class={`btn btn-sm w-full ${open ? "btn-neutral" : "btn-ghost"}`}
      aria-pressed={open ? "true" : "false"}
      onclick={() => {
        param.set(open ? "" : "1");
      }}
    >
      <SquareTerminal />
      Terminal
    </button>
  );
};

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

export const SourceBrowser = ({
  appId,
  base,
  file,
  gitRef,
  onDraftsReady,
  onState,
  preview,
  terminal,
  terminalParam,
}: SourceBrowserProps) => {
  // Per-instance state that must outlive re-renders; atom.lazy returns the
  // same box every render.
  const box = atom.lazy(newBrowserBox)();
  const notice = atom("");
  /** A save that did not reach IndexedDB, kept apart from `notice`: a write
   * that lands in the pod clears that one, and it says nothing about whether
   * the work is being kept. */
  const saveNotice = atom("");
  /** Report a failure that would otherwise lose work quietly: a save the
   * browser refused (a full store, a denied quota, a partition that went away)
   * or a teardown step that threw. The pod keeps retrying its own saves, so the
   * banner is the only sign the user gets that what the editor shows is not
   * being kept. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a save failure and a teardown failure are unknown by construction; this narrows both to text.
  const reportFailure = (error: unknown): void => {
    saveNotice.set(
      `This workspace is not being saved in this browser: ${errorMessage(error)}`
    );
  };
  /** One step of the teardown, with its failure reported: the pod's own
   * teardown — and with it the last save — must run whatever a step before it
   * did, and nothing here may reject into a console nobody reads. */
  const teardown = async (
    step: (() => Promise<void>) | undefined
  ): Promise<void> => {
    try {
      await step?.();
    } catch (error) {
      reportFailure(error);
    }
  };
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
    // Nothing is painted until the checkout is open, and opening it means a
    // tar of up to the Code-mode cap: draw both panes' skeletons, so a slow
    // open reads as work rather than a blank, broken page. Each goes the
    // moment its pane has something real to show (the rows, a file, an
    // error).
    paintSkeleton(treeEl, "tree", OPENING_NOTE);
    paintSkeleton(codeEl, "code", OPENING_NOTE);
    const aborted = (): boolean => signal.aborted;
    /** Only the default branch takes edits: another ref's browse must not be
     * able to commit to it. */
    const onDefaultBranch = gitRef === base().defaultBranch;

    let pushing = false;
    let pushError = "";
    let pushed: PushedTo | null = null;
    let revision = 0;
    /** The workspace's changes, as of the last derive (see `onChanges`). */
    let changes: readonly WorkspaceChange[] = [];

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
    } catch (error) {
      // A chunk that fails to load (a deploy swapped the assets, the network
      // dropped) leaves the pane with nothing to render; say so and why. The
      // code pane's own wait note goes: nothing more is coming.
      codeEl.textContent = "";
      treeEl.textContent = `The editor failed to load: ${errorMessage(error)}. Reload the page to retry.`;
      return;
    }
    if (aborted()) {
      return;
    }

    // The pod frame: the ref's listing opens it (or restores what it saved),
    // and every read and write below goes through the RPC to it. The first
    // thing in is the app's preview origin, which is where the frame — and
    // with it the whole pod — must live.
    let workspace: Workspace;
    try {
      const [listing, previewOrigin] = await Promise.all([
        sourceTree({ appId, ref: gitRef }),
        preview.origin(),
      ]);
      const checkout = await openSourceWorkspace({
        appId,
        branch: gitRef,
        editable: onDefaultBranch,
        fetchArchive: (ref) => fetchSourceArchive(appId, ref),
        files: listing.files,
        onSaveError: reportFailure,
        previewOrigin,
        sha: listing.sha,
      });
      const { connection, workspace: opened } = checkout;
      workspace = opened;
      // The checkout is open: whatever the Preview panel asks for from here on
      // (a plan, a server) runs on this frame. A read-only ref previews too —
      // only its mutations are refused, and the preview runs no mutations. The
      // terminal's shell runs here too, and goes away with the checkout.
      preview.attach(connection);
      terminal.attach(connection);
    } catch (error) {
      // A ref the archive route refuses (too large, gone), a preview origin
      // that cannot be read, or a frame that never answered leaves the pane
      // with nothing to show; say so and why. The tree's wait note goes with
      // it: no rows are coming.
      treeEl.textContent = "";
      codeEl.textContent = errorMessage(error);
      return;
    }
    if (aborted()) {
      await workspace.close();
      return;
    }

    const syncState = () => {
      onState({
        files: changes,
        pushError,
        pushed,
        pushing,
        revision,
        // The notice names the commit the pod is based on; the pod only calls
        // itself stale against a tip that moved on from it.
        stale: workspace.stale === null ? null : workspace.baseSha,
      });
    };

    /** A change landed: whatever the last push said is superseded. */
    const report = () => {
      pushError = "";
      pushed = null;
      revision += 1;
      syncState();
    };

    /** A keystroke's text lands in the pod: the derive it triggers re-marks the
     * tree and the panel, so nothing else has to be told. A write the pod
     * refuses (a volume out of room) says so in the pane's notice — and a
     * later write that lands clears it, so the banner never claims a condition
     * the pod no longer has. */
    const writeText = async (path: string, text: string): Promise<void> => {
      try {
        await workspace.writeText(path, text);
        notice.set("");
      } catch (error) {
        notice.set(errorMessage(error));
      }
    };

    const editor = createEditorPane({
      aborted,
      appId,
      changes: () => changes,
      codeEl,
      diffs,
      edit: editMod,
      editChanged: (path, text) => {
        const written = writeText(path, text);
        report();
        return written;
      },
      file,
      gitRef,
      workspace,
    });

    const tree = createTreeWiring({
      aborted,
      changes: () => changes,
      editable: () => workspace.editable,
      file,
      followMove: editor.followMove,
      getCurrentPath: editor.getCurrentPath,
      openFile: editor.openFile,
      placeCaret: editor.placeCaret,
      report,
      signal,
      syncOpen: editor.syncOpen,
      treeEl,
      trees,
      workspace,
    });

    // Commit the workspace's changes and push: to the default branch, or to a
    // new branch started at the default branch's tip.
    const commit: CommitDrafts = async ({ branch, message }) => {
      if (pushing || changes.length === 0) {
        return false;
      }
      pushing = true;
      pushError = "";
      syncState();
      try {
        await workspace.push(
          // The ref the commit lands on: the branch the form named, or this
          // pod's own branch when it named none.
          branch === undefined
            ? { message, target: base().defaultBranch }
            : { branch, message, target: branch },
          (payload) => {
            // The runner weighs the whole commit before it writes anything:
            // catch it here, where the message can still say which file is the
            // problem.
            const breach = checkLimits(
              payload.files.map((one) =>
                one.encoding === "base64"
                  ? {
                      base64: one.content,
                      bytes: base64Bytes(one.content),
                      kind: "binary",
                      path: one.path,
                    }
                  : { kind: "text", path: one.path, text: one.content }
              ),
              UPLOAD_LIMITS
            );
            if (breach !== null) {
              tree.notify(breach);
              throw new Error(breach);
            }
            const args: SourceCommitInput = {
              appId,
              files: payload.files,
              message,
            };
            if (payload.moves.length > 0) {
              args.moves = payload.moves;
            }
            if (payload.deletes.length > 0) {
              args.deletes = payload.deletes;
            }
            if (branch !== undefined) {
              args.branch = branch;
              const { mainSha } = base();
              if (mainSha) {
                args.fromSha = mainSha;
              }
            }
            return commitSource(args);
          }
        );
        pushed = {
          branch: branch ?? base().defaultBranch,
          newBranch: branch !== undefined,
        };
        if (branch !== undefined) {
          // The pod went back to its own base (the commit lives on the branch
          // the form named), so the rows follow what the checkout holds now.
          void tree.resync();
        }
        if (editor.startedIntel()) {
          // The repo moved: every file that is not the open one now exists at a
          // newer commit, so the worker re-reads the bundle (and re-parses the
          // config) instead of checking against the previous one.
          editor.resetIntel();
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

    // Every derive lands here: the tree's markers and the page's copy of the
    // changes move together, and the open file is re-read from the pod every
    // time: a derive can mean the bytes under the pane changed without the
    // pane having written them (a discard, an undo, a push that landed on
    // another branch), and `syncOpen` is the one place that repaints only what
    // differs from what the pane shows.
    const unsubscribe = workspace.onChanges((next) => {
      changes = next;
      tree.syncStatus();
      revision += 1;
      syncState();
      void editor.syncOpen();
    });
    // Another tab's edits landed in this pod: the derive they trigger repaints
    // the markers and the open file, but a path that came, went or moved has
    // to reach the tree's rows too.
    const stopPeers = workspace.onPeerChange((structural) => {
      if (structural) {
        void tree.resync();
      }
    });
    // Files the terminal or a preview process makes, removes or renames never
    // pass through the tree's own flows — but they do cross the pod's watcher,
    // which reports them as `rename` events (a content write is `change`, and
    // the derive it triggers already repaints the markers and the open file).
    let resyncTimer = 0;
    const stopStructuralWatch = workspace.fs.watch(
      PROJECT_ROOT,
      { recursive: true },
      (event, filename) => {
        if (event !== "rename") {
          return;
        }
        // An install writes thousands of dependency files the walk skips anyway.
        if (filename?.split("/").includes("node_modules")) {
          return;
        }
        clearTimeout(resyncTimer);
        resyncTimer = window.setTimeout(() => {
          void tree.resync();
        }, STRUCTURAL_DEBOUNCE_MS);
      }
    );

    /** The pod's own save is debounced, so the last keystroke is saved here
     * before the page goes: a reload, a hidden (possibly frozen) tab or a
     * closed pane must not lose work the page already reported. `flush`
     * rejects when the save failed, so its rejection is reported rather than
     * dropped (the pod's own error event reports the same failure — the
     * banner is set twice with the same words, which changes nothing). */
    const savePending = () => {
      void (async () => {
        try {
          await workspace.flush();
        } catch (error) {
          reportFailure(error);
        }
      })();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        savePending();
      }
    };
    addEventListener("pagehide", savePending);
    document.addEventListener("visibilitychange", onHidden);

    onCleanup(() => {
      removeEventListener("pagehide", savePending);
      document.removeEventListener("visibilitychange", onHidden);
      unsubscribe();
      stopPeers();
      clearTimeout(resyncTimer);
      stopStructuralWatch.close();
      editor.dispose();
      tree.cleanUp();
      editor.cleanUp();
      void (async () => {
        // The preview's servers stop before the pod does: a process left on a
        // torn-down pod is a leaked process and a leaked port. The terminal's
        // shell goes with them.
        await teardown(preview.detach);
        await teardown(terminal.detach);
        await teardown(workspace.close);
      })();
    });

    onDraftsReady({
      commit,
      discard: tree.discard,
      discardAll: tree.discardAll,
      restore: tree.restorePath,
    });

    try {
      // The workspace derives once while it opens — a pod that already held the
      // branch, unpushed work included, answers with its rows there — and that
      // happens before any subscriber can exist. So the rows are read here
      // rather than awaited: painting them is what makes a reloaded page look
      // like the page that was reloaded.
      changes = workspace.changes();
      // Paint the checkout: every file and every empty folder as a row, and
      // the commit's own markers, with the file the browse names (or the
      // Worker config) opened over it.
      const listing = await workspace.listing();
      const initial = tree.buildTree(listing);
      if (initial === undefined) {
        // Nothing to open: say what the pane is waiting for, rather than
        // leaving the "Opening checkout…" note standing over an open checkout.
        codeEl.textContent =
          listing.files.length === 0 ? NO_FILES_NOTE : SELECT_FILE_NOTE;
      } else {
        await editor.openFile(initial);
      }
      if (aborted()) {
        return;
      }
      revision += 1;
      syncState();
    } catch (error) {
      treeEl.textContent = "";
      codeEl.textContent = errorMessage(error);
    }
  });

  // One page grid holds the tree column, the editor column, the side panel and
  // the terminal panel: this wrapper dissolves (`contents`) so the two columns
  // below are the grid's own items, placed explicitly (the browser never
  // repaints for `?panel=`/`?terminal=`, so the placement must not depend on
  // them — `row-end-[-1]` spans one row closed and two rows open). The side
  // panel stays a sibling in the page, so a ref change remounts this subtree
  // without touching its preview frame.
  return (
    <div class="contents">
      <div class="bg-base-200/50 border-base-300 col-start-1 row-start-1 row-end-[-1] flex min-h-0 min-w-0 flex-col justify-between border-r">
        <div
          ref={attach("tree")}
          class="noite-src-tree min-h-0 min-w-0 flex-1 overflow-auto pt-2"
        ></div>
        <div class="border-base-300 border-t p-2">
          <TerminalToggle param={terminalParam} />
        </div>
      </div>
      <div class="col-start-2 row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
        {saveNotice() === "" ? null : (
          <p
            class="bg-error/20 text-base-content border-base-300 m-0 border-b px-3 py-2 text-xs"
            role="alert"
          >
            {saveNotice()}
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
        <div
          ref={attach("code")}
          class="min-h-0 min-w-0 flex-1 overflow-auto"
        ></div>
      </div>
    </div>
  );
};
