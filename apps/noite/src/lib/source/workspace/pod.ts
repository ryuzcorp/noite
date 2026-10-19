//! Opening the pod a workspace runs on. The pod is Noite's whole filesystem:
//! the checkout, the metadata beside it and — for an editable ref — its
//! IndexedDB copy. Every tab that opens an editable ref is editable: one of
//! them holds the copy's lock and saves it, the others restore it and stay in
//! step over `tab-sync.ts`, queued for the lock so one of them saves when the
//! saving tab goes.
//!
//! The pod's *code* does not run in the control UI. This module boots inside
//! the pod frame — a document on the app's pod host origin (`pod-host/main.ts`)
//! — so the commands a workspace runs (installs and their scripts, the app's
//! own dev script, builds, the terminal) execute on an origin that holds none
//! of the control page's authority. The pod boots with path URLs on
//! that same origin, the one origin the frame's own service worker may route.
//!
//! This is the only module in the directory that imports the SDK; everything
//! else takes the plain filesystem shape it hands out.

import {
  createIndexedDBWorkspaceStore,
  Nodepod,
  WorkspacePersistence,
} from "@r1ck404/nodepod";
import type {
  NodepodOptions,
  PersistenceOptions,
  VolumeMutation,
  WorkspaceStore,
} from "@r1ck404/nodepod";

import {
  POD_HOST_DEV_PATHS,
  POD_HOST_PATHS,
  POD_SW_PATH,
  POD_WORKER_PATH,
} from "../../preview-host";
import {
  UNPERSISTED_DIRS,
  UNSAVED_PROJECT,
  mirrorStorage,
  restoreMirror,
  startMirror,
} from "./state-mirror";
import type { MirrorMutation, MirrorVolume } from "./state-mirror";
import { syncChannelName, syncTabs } from "./tab-sync";
import type { TabSync } from "./tab-sync";
import { PROJECT_ROOT } from "./types";
import type { OpenPod, PodOptions, SaveErrorReporter } from "./types";

export type { OpenPod, PodOptions } from "./types";

/** The persistence key of one editable ref: distinct ids are distinct saved
 * workspaces, so the id has to name the app and the branch and nothing else. */
export const persistenceId = (appId: string, branch: string): string =>
  `noite:${appId}:${branch}`;

/** The SDK's mutation union down to what the state mirror records. */
const toMirrorMutation = (mutation: VolumeMutation): MirrorMutation => {
  if (mutation.op === "write") {
    return { op: "write", path: mutation.path };
  }

  if (mutation.op === "remove") {
    return { op: "remove", path: mutation.path };
  }

  if (mutation.op === "rename") {
    return { from: mutation.from, op: "rename", to: mutation.to };
  }

  return { op: "ignore" };
};

/** The quiet time before a save: long enough that a keystroke burst is one
 * commit to IndexedDB, short enough that closing the tab loses nothing. */
const PERSIST_DEBOUNCE_MS = 250;

const persistenceOptions = (id: string): PersistenceOptions => ({
  debounceMs: PERSIST_DEBOUNCE_MS,
  excludeDirNames: UNPERSISTED_DIRS,
  id,
  lock: "error",
  requestPersistentStorage: true,
});

/** The boot options every pod carries: the checkout as the working directory —
 * so the installer's `node_modules` lands beside the `package.json` it installs
 * from — the process-worker bundle this frame serves, and the paths the pod
 * host's service worker must leave to the host: this frame's document and
 * bundle, its worker asset and the worker script itself. Those are the host's:
 * once a pod's own server has claimed the origin, the worker would otherwise
 * route the very document that runs the pod — and the assets it loads — to a
 * pod.
 *
 * `previewOrigin: false` is the shape the frame needs: this document *is* the
 * app's pod host origin, so a virtual server's URL is a path on it
 * (`${location.origin}/__virtual__/…`) rather than a host of its own, which is
 * unambiguous per tab and avoids Nodepod's origin-bound service-worker mode.
 *
 * The reserved paths are the host's own URL space: this frame's document and
 * bundle, Nodepod's worker asset and its service worker, plus — in dev, where
 * the document is the module graph rather than a bundle — the dev server's
 * roots (`POD_HOST_DEV_PATHS`; see it for why a module fetch needs each module
 * reserved, not only the entry). */
const bootOptions = (): NodepodOptions => ({
  previewOrigin: false,
  reservedHostPaths: [
    ...POD_HOST_PATHS,
    POD_WORKER_PATH,
    POD_SW_PATH,
    ...(import.meta.env.DEV === true ? POD_HOST_DEV_PATHS : []),
  ],
  workdir: PROJECT_ROOT,
  workerUrl: POD_WORKER_PATH,
});

/** The code a boot fails with when another tab holds the workspace lock. The
 * package's own error type is not exported from its entry points, so the code
 * is what is checked. */
const LOCKED_CODE = "EWORKSPACELOCKED";

/** How long a tab that opens second waits for the saving tab to flush before
 * it restores anyway (a frozen or closing tab never answers). */
const PEER_FLUSH_WAIT_MS = 1500;

/** The pieces of one booted pod that close with it. */
interface HeldPod {
  editable: boolean;
  persistence: WorkspacePersistence | null;
  /** Whether this tab saves the workspace now. A following tab's saves are
   * refused until it is granted the lock (see `gatedStore`), and a refusal is
   * not this tab's error to report. Absent: always. */
  saves?: () => boolean;
  /** Ends the synchronous write-through mirrors (see `startMirrors`). */
  stopMirror?: () => void;
  sync?: TabSync;
}

/** A booted pod as the workspace layer wants it: the filesystem, the way to
 * make a save land right now, and the way back out. */
const hold = (pod: Nodepod, held: HeldPod): OpenPod => {
  const { editable, persistence, saves = () => true, stopMirror, sync } = held;

  // A refused save is not this tab's error to report (see `gatedStore`).
  const save = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (saves()) {
        throw error;
      }
    }
  };

  return {
    close: async () => {
      sync?.close();
      stopMirror?.();

      if (persistence) {
        await save(() => persistence.close());
      }

      await pod.teardown();
    },
    editable,
    flush: async () => {
      if (persistence) {
        await save(() => persistence.flush());
      }
    },
    fs: pod.fs,
    onPeerChange: (notify) =>
      sync?.onApplied(notify) ??
      (() => {
        // A pod opened without editing is never synced: nothing to unsubscribe.
      }),
    persistence,
    pod,
  };
};

/** The pod's volume as the SDK-free mirror sees it: the same synchronous
 * calls, with mutations classified down at this boundary. */
const classifyMutation =
  (listener: (mutation: MirrorMutation) => void) =>
  (event: VolumeMutation): void => {
    listener(toMirrorMutation(event));
  };

const mirrorVolume = (pod: Nodepod): MirrorVolume => {
  const { volume } = pod.fs;

  return {
    existsSync: (path) => volume.existsSync(path),
    mkdirSync: (path, options) => {
      volume.mkdirSync(path, options);
    },
    onMutation: (listener) => volume.onMutation(classifyMutation(listener)),
    readFileSync: (path) => volume.readFileSync(path),
    readdirSync: (path) => volume.readdirSync(path),
    removeTreeSync: (path) => {
      volume.removeTreeSync(path);
    },
    writeFileSync: (path, data) => {
      volume.writeFileSync(path, data);
    },
  };
};

/** Overlay this tab's synchronous mirror onto a booted pod: after the
 * IndexedDB restore, before anything reads the volume. The mirror is this
 * tab's own record, newer-or-equal to the restore; a tab with none overlays
 * nothing, and a read-only ref has no edits to replay. */
const restoreMirrors = (pod: Nodepod, id: string, editable: boolean): void => {
  if (!editable) {
    return;
  }

  restoreMirror(mirrorVolume(pod), UNSAVED_PROJECT, id, mirrorStorage());
};

/** Record the checkout's unsaved writes synchronously, into this tab's
 * sessionStorage, and answer with the way to stop. The project mirror only
 * has to outlive IndexedDB's debounce: once a save leaves nothing pending,
 * everything in it is saved, so it is emptied — it never replays text older
 * than the saved copy, and a fresh checkout's first save (which outgrows it)
 * lets it record again. */
const startMirrors = (
  pod: Nodepod,
  id: string,
  persistence: WorkspacePersistence | null
): (() => void) => {
  const project = startMirror(
    mirrorVolume(pod),
    UNSAVED_PROJECT,
    id,
    mirrorStorage()
  );

  const onSaved = (): void => {
    if (persistence?.pendingChanges === 0) {
      project.clear();
    }
  };

  persistence?.on("saved", onSaved);

  return () => {
    persistence?.off("saved", onSaved);
    project.stop();
  };
};

/** The tabs' channel, over the pod's own volume (the SDK's `MemoryVolume` is
 * the sync's `SyncVolume` as is). */
const openSync = (pod: Nodepod, id: string): TabSync =>
  syncTabs(pod.fs.volume, new BroadcastChannel(syncChannelName(id)));

/** The lock a tab that opened second queues for. The name is the one the SDK
 * takes the saved workspace's lock under (`acquireWorkspaceLock`, not
 * exported), so the SDK's own boot in a third tab still finds it held. The
 * returned lock is the SDK's `WorkspaceLock` shape: releasing it before it was
 * granted leaves the queue. */
const queueForLock = (id: string) => {
  const leave = new AbortController();
  const released = Promise.withResolvers<undefined>();
  const granted = Promise.withResolvers<boolean>();

  const release = (): void => {
    leave.abort();
    released.resolve();
  };

  const lock = {
    onLost: null,
    release,
    releaseAfter: async (done: Promise<unknown>) => {
      try {
        await done;
      } catch {
        // Settled is all the release waits for.
      }

      release();
    },
  };

  const request = async (): Promise<void> => {
    try {
      await navigator.locks.request(
        `nodepod-workspace:${id}`,
        { signal: leave.signal },
        () => {
          granted.resolve(true);

          return released.promise;
        }
      );
    } catch {
      // Left the queue before it was granted (the tab closed first).
    }

    granted.resolve(false);
  };

  void request();

  return { granted: granted.promise, lock };
};

/** A following tab's save refused by `gatedStore`: kept pending and retried
 * by the pod, so there is nothing to report. */
const ignoreRefusedSave = (): void => {
  // Expected until the lock is granted.
};

/** The saved workspace's store, refusing to commit until this tab is the one
 * that saves. The pod keeps a refused change pending and retries it, so
 * everything this tab changed while following — its own edits and the ones it
 * applied — is saved as soon as it takes over, including what a saving tab
 * that died never got to save. */
const gatedStore = (
  store: WorkspaceStore,
  saves: () => boolean
): WorkspaceStore => ({
  clear: () => store.clear(),
  close: () => {
    store.close?.();
  },
  commit: async (batch) => {
    if (!saves()) {
      throw new Error("workspace: another tab saves this workspace");
    }

    await store.commit(batch);
  },
  load: () => store.load(),
  readBlobs: (ids) => store.readBlobs(ids),
  sweep: async () => {
    if (saves()) {
      await store.sweep?.();
    }
  },
});

/** Take over saving once this tab is granted the lock: the tab that saved
 * has gone. What piled up while following is saved right away. */
const saveWhenGranted = async (
  granted: Promise<boolean>,
  persistence: WorkspacePersistence,
  sync: TabSync,
  takeOver: () => void
): Promise<void> => {
  if (!(await granted) || persistence.status === "closed") {
    return;
  }

  takeOver();
  sync.serveFlush(() => persistence.flush());

  try {
    await persistence.flush();
  } catch {
    // The pod retries a failed save on its own.
  }
};

/** The tab that holds the saved workspace: it restored it in its boot, saves
 * it, and flushes it whenever a tab opening second asks. A save that fails — a
 * full store, a denied quota, a partition that went away — is reported: the pod
 * keeps retrying on its own, but the page has to say that what it shows is not
 * being kept. */
const holdSaving = (
  pod: Nodepod,
  id: string,
  onSaveError: SaveErrorReporter
): OpenPod => {
  restoreMirrors(pod, id, true);
  const sync = openSync(pod, id);
  const { persistence } = pod;

  if (persistence) {
    sync.serveFlush(() => persistence.flush());
    persistence.on("error", onSaveError);
  }

  sync.start();

  return hold(pod, {
    editable: true,
    persistence,
    stopMirror: startMirrors(pod, id, persistence),
    sync,
  });
};

/** A tab that opens a workspace another tab saves: it has the saving tab
 * flush, restores the saved copy, applies what changed since, and queues for
 * the lock — granted, it starts saving from where it stands. */
const holdFollowing = async (
  pod: Nodepod,
  id: string,
  onSaveError: SaveErrorReporter
): Promise<OpenPod> => {
  const sync = openSync(pod, id);
  await sync.flushPeers(PEER_FLUSH_WAIT_MS);
  const store = createIndexedDBWorkspaceStore(id);
  let saving = false;
  const saves = (): boolean => saving;
  let persistence: WorkspacePersistence | null = null;

  if (store !== null) {
    const queued = queueForLock(id);
    persistence = new WorkspacePersistence(
      id,
      pod.fs.volume,
      gatedStore(store, saves),
      { debounceMs: PERSIST_DEBOUNCE_MS, excludeDirNames: UNPERSISTED_DIRS },
      queued.lock
    );
    // Refused saves are expected until the lock is granted; the pod would
    // warn about each one. Once this tab is the one that saves they are real
    // failures, and the page hears about them like the saving tab's.
    const held = persistence;
    persistence.on("error", ignoreRefusedSave);
    await persistence.load();
    // Tracking starts after the restore (which must not be saved back) and
    // before the peers' changes are applied.
    persistence.attach();
    void saveWhenGranted(queued.granted, persistence, sync, () => {
      saving = true;
      held.off("error", ignoreRefusedSave);
      held.on("error", onSaveError);
    });
  }

  restoreMirrors(pod, id, true);
  sync.start();

  return hold(pod, {
    editable: true,
    persistence,
    saves,
    stopMirror: startMirrors(pod, id, persistence),
    sync,
  });
};

/** Boot the pod for one ref. An editable ref opens its saved workspace; when
 * another tab already saves it, this tab follows that tab (see
 * `holdFollowing`), editable all the same. */
export const openPod = async (options: PodOptions): Promise<OpenPod> => {
  const { appId, branch, editable, onSaveError } = options;
  const id = persistenceId(appId, branch);
  const boot = bootOptions();

  if (!editable) {
    const pod = await Nodepod.boot(boot);
    restoreMirrors(pod, id, false);

    return hold(pod, { editable: false, persistence: null });
  }

  try {
    const pod = await Nodepod.boot({
      ...boot,
      persistence: persistenceOptions(id),
    });

    return holdSaving(pod, id, onSaveError);
  } catch (error) {
    const lockedOut =
      error instanceof Error && "code" in error && error.code === LOCKED_CODE;

    if (!lockedOut) {
      throw error;
    }

    return holdFollowing(await Nodepod.boot(boot), id, onSaveError);
  }
};
