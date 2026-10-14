/**
 * Source browser: file tree (@pierre/trees) + code preview and editor
 * (@pierre/diffs), both mounted imperatively from their vanilla APIs.
 *
 * The two pane hosts use `ref` callbacks; setup runs once in
 * `watch.once(async ({ signal, onCleanup }) => …)` (client-only, once per
 * mount) and aborts via `signal` on unmount. Change/push state flows back
 * through `onState`, and the row actions through `onDraftsReady`.
 *
 * One browser serves an app's whole session, not one mount per ref: its view
 * reads `?ref=` and asks for that ref's checkout (`request` → `ensure` →
 * `install`), so a branch switch installs another checkout under the same
 * tree, editor, edit session and intel worker. What the panes show is only
 * replaced when the new ref's rows and file are ready; until then the branch
 * the user came from stands, marked as switching (see `switching`). The
 * checkout the user came from stays open (`WARM_MS`) for the trip back.
 *
 * Data comes from the pod, which lives in a document on the app's pod host
 * origin: `openSourceWorkspace` (`./workspace/proxy`) frames it, hands it the
 * ref's listing (`sourceTree` names the commit and its blobs) and answers its
 * archive ask with the tar the control's own session fetched, and every read
 * and write in the panes goes over that RPC — the browser never sees tokens,
 * nothing app-controlled runs on this origin, and there is no draft store
 * beside it. A checkout is a whole pod per ref, and a ref's drafts are
 * persisted with it (the workspace's own IndexedDB store, keyed by app and
 * branch) — one ref's work never reaches another's.
 *
 * The pane also speaks TypeScript: `SourceIntel` (./intel) drives a lazily
 * created language-service worker that gets the repo's sources and the
 * workspace's changed files, fetches the package declarations it needs from
 * esm.sh itself, and answers diagnostics (pierre markers), hover,
 * go-to-definition and inline prediction. Everything the compiler needs stays
 * in that worker — the main bundle never imports it.
 *
 * This file is composition only: it loads the vendor modules, opens the
 * checkouts, mounts the tree and editor panes (`./tree`, `./editor`) over
 * them, and drives the push.
 */
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { commitSource, previewSource } from "../commit-source";
import type { SourceCommitInput } from "../commit-source";
import { errorMessage } from "../errors";
import { forgeRefs, invalidateForge } from "../forge/data";
import { collectRef, newLiveRef, whenLive } from "../live-ref";
import type { LiveRef } from "../live-ref";
import type { SearchParam } from "../search-param";
import { sourceTree } from "../server/source.server";
import { fetchSourceArchive } from "../source-archive";
import { MORPH_PRESERVE } from "../ui/resizable";
import type {
  CommitDrafts,
  DraftActions,
  PreviewDrafts,
  PreviewedSnapshot,
  PushedTo,
  ReadOnlyRef,
  SourceBrowserState,
} from "./drafts";
import { createEditorPane } from "./editor";
import { IGNORE_FILE } from "./gitignore";
import { paintSkeleton, paneIn } from "./pane";
import type { DiffsModule, EditModule, TreesModule } from "./pierre";
import type { PodConnection } from "./pod-client";
import { changesFingerprint } from "./preview-env";
import { previewPayload } from "./preview-payload";
import type { TerminalLink } from "./terminal-session";
import { createTreeWiring } from "./tree";
import { base64Bytes, checkLimits, UPLOAD_LIMITS } from "./uploads";
import { openSourceWorkspace } from "./workspace/proxy";
import { PROJECT_ROOT } from "./workspace/types";
import type {
  PushPayload,
  Workspace,
  WorkspaceChange,
  WorkspacePush,
} from "./workspace/types";

export interface SourceBrowserProps {
  appId: string;
  /** Why `ref` opens read-only — `""` when it names a branch the viewer may
   * push to (a tag or a raw commit sha stays read-only, and so does a `view`
   * collaborator's checkout — see `./push-target`). The refs list and the
   * viewer's role arrive after this browser mounts, so it is asked, not handed
   * a value. */
  canEditRef: (ref: string) => Promise<ReadOnlyRef>;
  file: SearchParam<string>;
  /** Branch/tag/SHA the tree is read from, in step with `?ref=` (the page
   * defaults it to the default branch). An atom the browser *watches*, not the
   * param handle: a ref change is this browser's own business — it installs
   * the new ref's checkout under the panes it already has instead of being
   * remounted (see `request`) — and the request it starts must not be one
   * started during a render (ilha's atom rule). */
  gitRef: AtomHandle<string>;
  onState: (state: SourceBrowserState) => void;
  /** Called once per mount with what the page's panels may ask the drafts. */
  onDraftsReady: (actions: DraftActions) => void;
  /** The app's pod host origin, resolved when the checkout opens: the frame
   * the pod lives in is embedded from it, so nothing app-controlled runs on
   * this page's origin. */
  podHostOrigin: () => Promise<string>;
  /** The terminal panel's session: the shell runs on the checkout this
   * browser opens, and goes away with it. */
  terminal: TerminalLink;
  /** The tree column's host, in the document: the page lays the columns out
   * (they are panes of its own resizable groups), so it renders the column and
   * hands the browser the mount point its pane attaches to. */
  treeHost: LiveRef<HTMLElement>;
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

/** How long a checkout the user left stays open for the trip back. Inside it a
 * switch is instant: nothing is fetched, nothing is untarred, and the branch's
 * unpushed drafts are exactly where the user left them. Past it the checkout is
 * closed and opened again, which is the only way the branch's moved tip — and
 * the checkout's staleness against it — is noticed (see
 * `./workspace/workspace`). */
const WARM_MS = 90_000;

/** One open checkout: the frame's connection, the ref and commit it holds, and
 * the workspace the panes drive. */
interface Checkout {
  connection: PodConnection;
  ref: string;
  /** Why this ref's checkout is read-only (see `ReadOnlyRef`). */
  readOnly: ReadOnlyRef;
  /** The commit the checkout is based on (the browse's resolved tip). */
  sha: string;
  workspace: Workspace;
}

/** The commit that carries a preview snapshot: the panel paints it, nothing
 * else reads it (a preview is not a push, and its message never lands on a
 * branch). */
const PREVIEW_MESSAGE = "Preview from Code mode";

/** What the banner above the editor says about a read-only checkout. */
const READ_ONLY_NOTICE: Record<Exclude<ReadOnlyRef, "">, string> = {
  commit:
    "Read-only — a commit checkout can't be edited. Switch to a branch to edit.",
  role: "Read-only — you need push access to edit.",
  tag: "Read-only — a tag checkout can't be edited. Switch to a branch to edit.",
};

/** Per-instance browser state that must outlive re-renders (see below). */
interface BrowserBox {
  /** The code pane's host as a live ref: re-renders also hand `ref` detached
   * scratch copies, so the setup resolves the connected host (live-ref.ts).
   * The tree column's host belongs to the page (it is a pane of the page's own
   * resizable group), which hands it over as a prop. */
  code: LiveRef<HTMLElement>;
  /** What the panes should be showing: the view asks through here when the
   * watched ref changes, and the setup installs that ref's checkout (see it).
   * A no-op until the setup installs it. */
  request: (ref: string, force?: boolean) => void;
}

const newBrowserBox = (): BrowserBox => ({
  code: newLiveRef<HTMLElement>(),
  request: () => {
    // Installed by `watch.once`, which runs before any paint can follow it.
  },
});

export const SourceBrowser = ({
  appId,
  canEditRef,
  file,
  onDraftsReady,
  onState,
  gitRef,
  podHostOrigin,
  terminal,
  treeHost,
}: SourceBrowserProps) => {
  // Per-instance state that must outlive re-renders; atom.lazy returns the
  // same box every render.
  const box = atom.lazy(newBrowserBox)();
  /** The app's branches. A push reads them to tell a branch it creates from
   * one the runner grows from its own tip, and it reads them when the push
   * runs — never during a render, so this component does not repaint with
   * them. */
  const refs = forgeRefs(appId);
  const notice = atom("");
  /** Why the installed checkout is read-only ("" = it is editable): what the
   * banner above the editor says, and what keeps the Changes form and Deploy
   * preview off. */
  const readOnly = atom<ReadOnlyRef>("");
  /** A save that did not reach IndexedDB, kept apart from `notice`: a write
   * that lands in the pod clears that one, and it says nothing about whether
   * the work is being kept. */
  const saveNotice = atom("");
  /** The ref a switch is opening ("" = none): the panes go on showing the
   * checkout they have — marked with this — until the new ref's rows and file
   * are ready to paint (see `install`). */
  const switching = atom("");
  /** Why the browsed ref could not be opened ("" = it is fine). What the panes
   * show is the failed ref's own state, and the card over them offers a retry
   * that opens the ref again. */
  const failure = atom("");
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
  const attach = (host: HTMLElement | null) => {
    collectRef(box.code, host);
  };
  watch.once(async ({ onCleanup, signal }) => {
    // The refs fire before insertion: wait for the hosts that are really in
    // the document, and only then give each its shadow pane (never on a
    // scratch copy the morph is about to discard). The tree column's host is
    // the page's, and is looked up the same way.
    const [treeColumn, codeColumn] = await Promise.all([
      whenLive(treeHost, signal),
      whenLive(box.code, signal),
    ]);
    if (signal.aborted || !treeColumn || !codeColumn) {
      return;
    }
    const treeEl = paneIn(treeColumn);
    const codeEl = paneIn(codeColumn);
    // Nothing is painted until the checkout is open, and opening it means a
    // tar of up to the Code-mode cap: draw both panes' skeletons, so a slow
    // open reads as work rather than a blank, broken page. Each goes the
    // moment its pane has something real to show (the rows, a file, an
    // error).
    paintSkeleton(treeEl, "tree", OPENING_NOTE);
    paintSkeleton(codeEl, "code", OPENING_NOTE);
    const aborted = (): boolean => signal.aborted;

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
    // and every read and write in the panes goes through the RPC to it. A
    // checkout is per ref, and this browser stays mounted across ref changes
    // (see `BrowserSlot`), so nothing below is bound to the ref it mounted
    // with: a switch installs another checkout under the same tree and editor
    // (see `install`) instead of tearing the panes down to skeletons.
    /** The checkout the panes drive, or null until the first one is in. */
    let current: Checkout | null = null;
    /** The workspace's changes, as of the last derive (see `install`). */
    let changes: readonly WorkspaceChange[] = [];
    /** The paths another tab changed that this one still holds an unsaved
     * edit to, most recent first (see `syncState`). */
    let conflicts: readonly string[] = [];
    /** Paths the user acknowledged: a peer write to one of them brings it
     * back (see `dismissConflicts`). */
    const dismissed = new Set<string>();
    /** Whether a preview snapshot is in flight (its own flag: a preview is
     * not a push, and neither one blocks the other's payload). */
    let previewing = false;
    let pushError = "";
    let pushed: PushedTo | null = null;
    let pushing = false;
    /** What the last preview deploy snapshotted, and where (see
     * `SourceBrowserState.previewed`). */
    let previewed: PreviewedSnapshot | null = null;
    let revision = 0;
    /** The installed ref's resolved commit: the tip a branch the Changes
     * panel creates starts from (the runner's `fromSha`). */
    let browsedSha = "";
    /** The installed checkout's subscriptions and watch (see `install`). */
    let unsubscribe: (() => void) | null = null;
    let stopPeers: (() => void) | null = null;
    let stopWatch: { close: () => void } | null = null;
    let resyncTimer = 0;
    /** The ref the newest request wants, so a repaint (or a click on the
     * branch already picked) is not a second open. */
    let wanted: string | null = null;
    /** The requests this browser has started: only the newest installs, and a
     * superseded one leaves its checkout to the cache. */
    let generation = 0;
    /** Whether the pane is gone: an open still in flight lands on nothing. */
    let closed = false;
    /** Every checkout this browser has opened and not closed, by ref, with the
     * time it was last installed. Refs are independent workspaces — their own
     * pods, their own persistence id, their own drafts — so one may be
     * installed while another stays warm. */
    const checkouts = new Map<string, { at: number; checkout: Checkout }>();
    /** The open in flight, so two requests for one ref share it. */
    let opening: { checkout: Promise<Checkout>; ref: string } | null = null;
    /** Frames that reported their pod gone (`onFatal`): never reused, never
     * read from again. */
    const dead = new Set<PodConnection>();

    /** The workspace the panes drive. They only ever reach it through an
     * installed checkout: before the first install they have nothing to show
     * and no call of theirs arrives here. */
    const installedWorkspace = (): Workspace => {
      if (current === null) {
        throw new Error("the checkout is not open yet");
      }
      return current.workspace;
    };
    const syncState = () => {
      const workspace = current?.workspace ?? null;
      const changed = new Set(changes.map((change) => change.path));
      onState({
        // A conflict only counts while the path is still a change of this
        // checkout: a peer write that put the path back to its committed
        // bytes leaves nothing to warn about.
        conflicts: conflicts.filter((path) => changed.has(path)),
        files: changes,
        previewed,
        pushError,
        pushed,
        pushing,
        readOnly: readOnly(),
        revision,
        // The notice names the commit the pod is based on; the pod only calls
        // itself stale against a tip that moved on from it.
        stale:
          workspace?.stale === null || workspace === null
            ? null
            : workspace.baseSha,
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
        await installedWorkspace().writeText(path, text);
        notice.set("");
      } catch (error) {
        notice.set(errorMessage(error));
      }
    };

    /** Close a checkout: whatever it still owes is saved, then its frame goes.
     * Nothing but an install keeps a checkout, so this is how a warm one (or
     * one whose frame died) ends. */
    const drop = (ref: string): void => {
      const held = checkouts.get(ref);
      if (held === undefined) {
        return;
      }
      checkouts.delete(ref);
      void teardown(() => held.checkout.workspace.close());
    };

    /** A checkout's frame died (its pod stopped): the ref has to be opened
     * again — nothing can be read from that one — and the user hears why. */
    const failed = (ref: string, message: string): void => {
      drop(ref);
      if (current?.ref === ref) {
        failure.set(message);
      }
    };

    /** Keep the installed checkout and the one the user came from. A checkout
     * nothing is looking at holds a whole pod — a frame, a filesystem, a
     * shell's processes — and the ref it holds anyway outlives it: what the
     * pod saved is in IndexedDB, keyed by app and branch. */
    const evict = (): void => {
      const idle = [...checkouts.entries()]
        .filter(([ref]) => ref !== current?.ref)
        .toSorted((a, b) => b[1].at - a[1].at);
      for (const [ref] of idle.slice(1)) {
        drop(ref);
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
      // The installed checkout's ref, so a worker read taken mid-switch names
      // the ref whose pod holds the files rather than the one the URL is
      // already pointing at.
      gitRef: () => current?.ref ?? gitRef(),
      workspace: installedWorkspace,
    });

    const tree = createTreeWiring({
      aborted,
      changes: () => changes,
      editable: () => installedWorkspace().editable,
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
      workspace: installedWorkspace,
    });

    /** The app's pod host origin, read once: every ref of this app frames the
     * same origin, and it does not change while the page is open. */
    let originOnce: Promise<string> | null = null;
    const podOrigin = (): Promise<string> => (originOnce ??= podHostOrigin());

    /** Open one ref's checkout: the ref's listing names the commit to check
     * out and the files a fresh checkout stamps as its base, the pod host
     * origin says where the frame — and with it the whole pod — must live, and
     * whether the ref opens editable is the page's answer (see `canEditRef`). */
    const openCheckout = async (ref: string): Promise<Checkout> => {
      const [listing, origin, reason] = await Promise.all([
        sourceTree({ appId, ref }),
        podOrigin(),
        canEditRef(ref),
      ]);
      const editable = reason === "";
      // The frame the fatal arrives on, for the handler below: the open
      // answers with it, and a pod that dies before that answer reports
      // itself through the open's own rejection.
      let frame: PodConnection | null = null;
      const checkout = await openSourceWorkspace({
        appId,
        branch: ref,
        editable,
        fetchArchive: (archiveRef) => fetchSourceArchive(appId, archiveRef),
        files: listing.files,
        onFatal: (message) => {
          if (frame !== null) {
            dead.add(frame);
          }
          failed(ref, message);
        },
        onSaveError: reportFailure,
        previewOrigin: origin,
        sha: listing.sha,
        // The pane going while this opens closes the frame too: nothing else
        // holds it before the open answers (see `SourceWorkspaceOptions.signal`).
        signal,
      });
      const { connection, workspace: opened } = checkout;
      frame = connection;
      if (closed || aborted()) {
        // The pane went while the frame was coming up: nothing will read it.
        void teardown(() => opened.close());
        throw new Error("the source pane closed while the checkout opened");
      }
      return {
        connection,
        readOnly: reason,
        ref,
        sha: listing.sha,
        workspace: opened,
      };
    };

    /** The checkout for `ref`: the warm one this browser already opened, or a
     * fresh open. One left idle past `WARM_MS` is opened again — the branch may
     * have moved while the user was away, and only an open re-reads its tip
     * (see the staleness rule in `./workspace/workspace`). */
    const ensure = async (ref: string): Promise<Checkout> => {
      const held = checkouts.get(ref);
      if (held !== undefined) {
        if (
          !dead.has(held.checkout.connection) &&
          Date.now() - held.at < WARM_MS
        ) {
          return held.checkout;
        }
        drop(ref);
      }
      if (opening?.ref === ref) {
        return await opening.checkout;
      }
      const pending = openCheckout(ref);
      opening = { checkout: pending, ref };
      try {
        const checkout = await pending;
        checkouts.set(ref, { at: Date.now(), checkout });
        return checkout;
      } finally {
        if (opening?.ref === ref) {
          opening = null;
        }
      }
    };

    /** The installed checkout's own filesystem events: files the terminal or
     * the pod's own processes make, remove or rename never pass through the
     * tree's own flows — but they do cross the pod's watcher, which reports
     * them as `rename` events (a content write is `change`, and the derive it
     * triggers already repaints the markers and the open file). An install
     * under `node_modules` is none of the tree's business (the row it would
     * leave is the dimmed folder alone) and the language service reads its
     * packages off the network. A `.gitignore` is the one content write that
     * does move rows: its rules decide which paths the walk descends into, so
     * the rows are rebuilt rather than just repainted. */
    const startWatch = (workspace: Workspace): { close: () => void } =>
      workspace.fs.watch(
        PROJECT_ROOT,
        { recursive: true },
        (event, filename) => {
          if (filename?.split("/").includes("node_modules")) {
            return;
          }
          const structural =
            event === "rename" || filename?.split("/").at(-1) === IGNORE_FILE;
          if (!structural) {
            return;
          }
          clearTimeout(resyncTimer);
          resyncTimer = window.setTimeout(() => {
            void tree.resync();
          }, STRUCTURAL_DEBOUNCE_MS);
        }
      );

    /** Put `next` under the panes. Everything that names a checkout — the
     * subscriptions, the watch, the commit's target — moves with it, while the
     * panes themselves (the pierre tree, the editor, its edit session, its
     * intel worker) stay: a switch re-syncs them, it does not rebuild them.
     *
     * The new ref's listing is read first, so a ref that cannot be read leaves
     * the old checkout exactly as it was, and what the panes *show* is only
     * replaced once the new ref's rows and file are ready to paint.
     *
     * `mine` is the request this install belongs to. Painting awaits, and a
     * newer request (another branch clicked while this one opened) may install
     * its own checkout meanwhile — everything after an await is therefore
     * checked against the generation, so a superseded install leaves the
     * terminal and the reported state to the checkout that is now on screen. */
    const install = async (next: Checkout, mine: number): Promise<void> => {
      const listing = await next.workspace.listing();
      if (closed || aborted() || mine !== generation) {
        return;
      }
      const previous = current;
      unsubscribe?.();
      unsubscribe = null;
      stopPeers?.();
      stopPeers = null;
      stopWatch?.close();
      stopWatch = null;
      clearTimeout(resyncTimer);
      current = next;
      browsedSha = next.sha;
      notice.set("");
      readOnly.set(next.readOnly);
      // Another ref's peer conflicts are not this one's: its paths are
      // checkout-relative to a checkout the panes no longer drive.
      conflicts = [];
      dismissed.clear();
      // The checkout derived once while it opened — a pod that already held the
      // branch, unpushed work included, answers with its rows there — and that
      // happened before any subscriber could exist. So the rows are read here
      // rather than awaited: painting them is what makes a switch land on the
      // branch's own unpushed work.
      changes = next.workspace.changes();
      pushError = "";
      pushed = null;
      revision += 1;
      unsubscribe = next.workspace.onChanges((rows) => {
        changes = rows;
        tree.syncStatus();
        revision += 1;
        syncState();
        void editor.syncOpen();
      });
      // Another tab's edits landed in this pod: the derive they trigger
      // repaints the markers and the open file, but a path that came, went or
      // moved has to reach the tree's rows too. A path this checkout also
      // holds a change to is a conflict the panel names (see `syncState`);
      // most recent first, and one the user acknowledged stays quiet for the
      // rest of this checkout.
      stopPeers = next.workspace.onPeerChange((structural, paths) => {
        const changed = new Set(changes.map((change) => change.path));
        const hit = paths.filter(
          (path) => changed.has(path) && !dismissed.has(path)
        );
        if (hit.length > 0) {
          const fresh = new Set(hit);
          conflicts = [...hit, ...conflicts.filter((path) => !fresh.has(path))];
          syncState();
        }
        if (structural) {
          void tree.resync();
        }
      });
      stopWatch = startWatch(next.workspace);
      // The panes are the same instances, and what they hold — the open file's
      // text and path, the worker's program — belongs to the checkout that
      // went. It goes without clearing what the pane shows: the open below
      // paints the new ref's file over it.
      editor.rebase();
      if (editor.startedIntel()) {
        // The repo under the worker changed: it re-reads the new ref's sources
        // instead of checking against the old one's.
        editor.resetIntel();
      }
      // Paint the checkout: every file and every empty folder as a row, and
      // the commit's own markers, with the file the browse names (or the
      // Worker config) opened over it — a file the new ref does not have falls
      // back to the config the same way a first open does.
      const initial = tree.buildTree(listing);
      if (initial === undefined) {
        // Nothing to open: say what the pane is waiting for, rather than
        // leaving the "Opening checkout…" note standing over an open checkout.
        codeEl.textContent =
          listing.files.length === 0 ? NO_FILES_NOTE : SELECT_FILE_NOTE;
      } else {
        await editor.openFile(initial);
      }
      // The paint awaited; a newer request may have installed and painted its
      // own checkout by now. The state it reported and the terminal it attached
      // are the newest request's to write, not this one's.
      if (closed || aborted() || mine !== generation) {
        return;
      }
      syncState();
      // The shell runs on the checkout the panes now drive: the one it was on
      // goes first, because a process left on a pod that is torn down later is
      // a leaked process and a leaked port.
      if (previous !== null) {
        await teardown(() => terminal.detach(previous.connection));
      }
      terminal.attach(next.connection);
    };

    /** What the panes should be showing: `ref` is the browser's own read of
     * `?ref=`, so every navigation asks and only a ref the checkout is not
     * already on starts anything. `force` is the retry a failure offered: it
     * drops whatever that attempt left and opens the ref again. */
    const request = (ref: string, force?: boolean): void => {
      if (force === true) {
        wanted = null;
        drop(ref);
      } else if (current?.ref === ref || wanted === ref) {
        return;
      }
      wanted = ref;
      generation += 1;
      const mine = generation;
      // Marked as switching only when there is something to keep on screen: a
      // first open has the panes' own note, and nothing to leave standing.
      switching.set(current === null ? "" : ref);
      failure.set("");
      void (async () => {
        try {
          const checkout = await ensure(ref);
          if (mine !== generation || closed) {
            return;
          }
          await install(checkout, mine);
          if (mine !== generation || closed) {
            return;
          }
          const held = checkouts.get(ref);
          if (held !== undefined) {
            held.at = Date.now();
          }
          switching.set("");
        } catch (error) {
          if (mine !== generation || closed) {
            return;
          }
          wanted = null;
          switching.set("");
          if (current === null) {
            // Nothing but the panes' own note is on screen: say what failed,
            // and leave what a switch kept standing alone when it did not.
            treeEl.textContent = "";
            codeEl.textContent = errorMessage(error);
          }
          failure.set(errorMessage(error));
        } finally {
          evict();
        }
      })();
    };

    // The commit body for one push payload: the runner weighs the whole commit
    // before it writes anything, and the breach is caught here, where the
    // message can still say which file is the problem. `branch` is always the
    // ref the commit writes — the runner's own default is the default branch,
    // which is not necessarily the one being browsed — and `fromSha` is the
    // tip a branch this push creates grows from.
    const commitInput = (
      payload: PushPayload,
      message: string,
      branch: string,
      fromSha: string | null
    ): SourceCommitInput => {
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
        branch,
        files: payload.files,
        message,
      };
      if (fromSha !== null) {
        args.fromSha = fromSha;
      }
      if (payload.moves.length > 0) {
        args.moves = payload.moves;
      }
      if (payload.deletes.length > 0) {
        args.deletes = payload.deletes;
      }
      return args;
    };

    // Commit the workspace's changes and push: to the branch being browsed, or
    // to a new branch started at its tip.
    const commit: CommitDrafts = async ({ branch, message }) => {
      const checkout = current;
      if (pushing || changes.length === 0 || checkout === null) {
        return false;
      }
      pushing = true;
      pushError = "";
      syncState();
      // The ref the commit lands on, and the ref the pod settles on after it:
      // the branch the form named, or the branch this checkout holds when it
      // named none. Naming a branch that does not exist yet is the only case
      // that starts somewhere else than its own tip.
      const target = branch ?? checkout.ref;
      // Whether the push leaves a branch behind to pull from: a named branch
      // the refs already hold is grown from its own tip, never created.
      const created =
        branch !== undefined &&
        refs.data()?.branches.some((known) => known.name === branch) !== true;
      const push: WorkspacePush = { message, target };
      if (branch !== undefined) {
        push.branch = branch;
      }
      try {
        await checkout.workspace.push(push, (payload) =>
          commitSource(
            commitInput(payload, message, target, branch ? browsedSha : null)
          )
        );
        pushed = { branch: target, newBranch: created };
        // The branch moved — the browsed one, or one the picker did not know
        // about yet: its tip, its distance from the default branch and every
        // History page were read before the commit and are stale now.
        invalidateForge(appId);
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

    /** Deploy preview: snapshot every uncommitted change as one commit on the
     * viewer's hidden preview ref and deploy that (viewer, branch) environment
     * — `POST /api/apps/{id}/source/preview`, which gates the session and the
     * push role server side before the runner snapshots and deploys. The
     * checkout is left exactly as it was: a preview is not a push — the base
     * does not move, the journal stays, and every change is still a change — so
     * the pod is asked for a fresh derive first (the payload is built from the
     * rows the pane shows) and the revision it snapshotted is recorded for the
     * panel's staleness notice. A failure lands in `pushError`, like a push's. */
    const preview: PreviewDrafts = async () => {
      const checkout = current;
      if (previewing || checkout === null || changes.length === 0) {
        return null;
      }
      previewing = true;
      pushError = "";
      syncState();
      try {
        await checkout.workspace.refresh();
        const payload = await previewPayload(checkout.workspace.fs, changes);
        // What this snapshot holds, taken before the request: an edit that
        // lands while the runner works is not part of it, and the panel has to
        // go on saying so.
        const snapshot = changesFingerprint(changes);
        const deployed = await previewSource({
          appId,
          branch: checkout.ref,
          deletes: payload.deletes,
          files: payload.files,
          message: PREVIEW_MESSAGE,
          moves: payload.moves,
        });
        previewed = { branch: checkout.ref, fingerprint: snapshot };
        return deployed;
      } catch (error) {
        pushError = errorMessage(error);
        return null;
      } finally {
        previewing = false;
        syncState();
      }
    };

    /** The pod's own save is debounced, so the last keystroke is saved here
     * before the page goes: a reload, a hidden (possibly frozen) tab or a
     * closed pane must not lose work the page already reported. `flush`
     * rejects when the save failed, so its rejection is reported rather than
     * dropped (the pod's own error event reports the same failure — the
     * banner is set twice with the same words, which changes nothing). */
    const savePending = () => {
      void (async () => {
        try {
          await current?.workspace.flush();
          // The pod's save is keeping up again: the banner was about a store
          // that refused, and holding it over a save that just landed would be
          // a claim the pod no longer meets.
          saveNotice.set("");
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
      closed = true;
      generation += 1;
      removeEventListener("pagehide", savePending);
      document.removeEventListener("visibilitychange", onHidden);
      unsubscribe?.();
      stopPeers?.();
      clearTimeout(resyncTimer);
      stopWatch?.close();
      editor.dispose();
      tree.cleanUp();
      editor.cleanUp();
      void (async () => {
        // The terminal's shell goes before the pod does: a process left on a
        // torn-down pod is a leaked process and a leaked port.
        const open = current;
        current = null;
        if (open !== null) {
          await teardown(() => terminal.detach(open.connection));
        }
        for (const ref of checkouts.keys()) {
          drop(ref);
        }
      })();
    });

    onDraftsReady({
      commit,
      discard: tree.discard,
      discardAll: tree.discardAll,
      dismissConflicts: (path) => {
        dismissed.add(path);
        conflicts = conflicts.filter((kept) => kept !== path);
        syncState();
      },
      preview,
      restore: tree.restorePath,
    });

    // The panes exist and the drafts are handed over: what is left is the ref
    // the URL names. A ref changed before this point is read here rather than
    // through the watch below, which only exists from the next paint on.
    box.request = request;
    request(gitRef(), false);
  });

  // The ref in step with the URL is the ref the panes browse: the page keys
  // this browser by app id (see `BrowserSlot`), so a picked branch reaches it
  // here and nowhere else. A watch, so the request it starts is never one
  // started during a render.
  watch(gitRef, (next) => {
    box.request(next);
  });

  // The editor column is a pane of the page's own group (the page lays the
  // columns out, and hands this browser the tree column's host); this wrapper
  // dissolves (`contents`), so the column below is the group's own pane and the
  // switch/failure overlays sit over the page beside it. The page's groups are
  // resizable, and their libraries' attributes survive this view's repaints
  // (see $lib/ui/resizable) — a ref change re-points the panes at the new
  // checkout in place, and never touches the page's own side of the split.
  //
  // Read once, so the banner's copy is picked from a narrowed value rather
  // than from a second read the compiler cannot narrow.
  const readOnlyNow = readOnly();

  return (
    <div class="contents">
      <div
        data-slot="resizable-panel"
        data-morph-preserve={MORPH_PRESERVE}
        class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {readOnlyNow === "" ? null : (
          <p
            class="bg-base-300/60 text-base-content border-base-300 m-0 border-b px-3 py-1.5 text-xs"
            role="status"
          >
            {READ_ONLY_NOTICE[readOnlyNow]}
          </p>
        )}
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
        <div ref={attach} class="min-h-0 min-w-0 flex-1 overflow-auto"></div>
      </div>
      {switching() === "" ? null : (
        <div
          class="absolute inset-0 z-20 cursor-progress"
          role="status"
          data-source-switch={switching()}
        >
          <div class="rounded-box border-base-300 bg-base-100/95 absolute top-2 right-2 flex items-center gap-2 border px-2.5 py-1.5 text-xs shadow-lg">
            <span class="loading loading-spinner loading-xs"></span>
            <span>
              Switching to <span class="font-mono">{switching()}</span>…
            </span>
          </div>
        </div>
      )}
      {failure() === "" ? null : (
        <div
          class="bg-base-100/85 absolute inset-0 z-30 flex items-center justify-center p-6"
          role="alert"
        >
          <div class="rounded-box border-base-300 bg-base-100 flex max-w-md flex-col items-start gap-3 border p-4 shadow-lg">
            <p class="m-0 text-sm">
              Could not open <span class="font-mono">{gitRef()}</span>:{" "}
              {failure()}
            </p>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              onclick={() => {
                box.request(gitRef(), true);
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
