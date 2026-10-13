//! The frame's preview: the app's own servers, running inside the pod.
//!
//! This is the runtime half of what used to be `lib/source/preview-session.ts`,
//! moved to where the pod is. It reads the files `planPreview` plans from,
//! runs `startPreview` over the pod, and holds the state the page's panel
//! draws. What it no longer does is reach for an origin: the frame *is* the
//! app's preview origin, so every URL the pod hands back has to be on this
//! document's own origin — that check is the one thing between a working
//! preview and a server framed from somewhere it must not be.
//!
//! The pod boots with path preview URLs (`previewOrigin: false` in `pod.ts`),
//! which are exactly that: `${location.origin}/__virtual__/…`, one namespace
//! per tab on the origin that owns the service worker routing them.

import { errorMessage } from "../lib/errors";
import type { PodPreviewLog, PodPreviewView } from "../lib/source/pod-protocol";
import type {
  PreviewHandle,
  PreviewOptions,
  PreviewPlan,
  PreviewPod,
  PreviewState,
} from "../lib/source/preview/types";
import { projectPath } from "../lib/source/workspace/types";
import type { FrameWorkspace } from "../lib/source/workspace/workspace";

/** The files `planPreview` plans from: the manifest, the edge config and the
 * bundler config, under every name a checkout can hold them. Only the ones
 * that exist are read. */
const PLAN_FILES = [
  "cloudflare.config.ts",
  "package.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.ts",
  "wrangler.json",
  "wrangler.jsonc",
] as const;

/** How much of the preview's own output the page keeps: an install or a build
 * can print more than a pane can hold, and the last lines are the ones that
 * say why it failed. */
const LOG_LIMIT = 500;

/** How a checkout's own files decide what runs: `planPreview` in
 * `preview/plan.ts`. */
export type PreviewPlanner = (
  files: ReadonlyMap<string, string>
) => PreviewPlan;

/** How a plan becomes a running preview: `startPreview` in `preview/start.ts`.
 * Both are handed in from the frame's entry rather than imported here: that
 * module reaches for Vite's `import.meta.glob` to carry Poder's dist into the
 * bundle, so anything importing it can only be run by a bundler — and this
 * runtime, which owns the preview's whole state machine, is the part worth
 * unit-testing against a fake spawner. */
export type PreviewStarter = (
  pod: PreviewPod,
  plan: PreviewPlan,
  options: PreviewOptions
) => Promise<PreviewHandle>;

/** The preview of one checkout, as the page's panel drives it: the plan, the
 * running handle, the log and the failure. */
export interface PodPreviewRuntime {
  /** A checkout opened: the preview runs on workspace.pod. */
  attach: (workspace: FrameWorkspace) => void;
  /** The panel closed: stop the preview's processes and ports. */
  close: () => Promise<void>;
  /** The checkout is going away: stop the preview and forget it. */
  detach: () => Promise<void>;
  /** Every line the preview prints, as it prints it — the terminal streams
   * them while the preview is its foreground job. */
  onLog: (listener: (line: PodPreviewLog) => void) => () => void;
  /** The panel opened: plan and start, once per checkout. */
  open: () => Promise<void>;
  /** Restart the preview's server in place. */
  restart: () => Promise<void>;
  /** Stop the preview's processes now — Ctrl+C in the terminal and its
   * `preview stop` command. The panel (or `restart`) starts it again. */
  stop: () => Promise<void>;
  /** The view changed (a state, a URL, a failure, a line): the frame sends
   * what `view()` now holds. */
  subscribe: (notify: () => void) => () => void;
  view: () => PodPreviewView;
}

/** The plan's files out of the pod, keyed checkout-relative. */
const readPlanFiles = async (
  workspace: FrameWorkspace
): Promise<Map<string, string>> => {
  const entries = await Promise.all(
    PLAN_FILES.map(async (path) => {
      const abs = projectPath(path);
      if (!(await workspace.fs.exists(abs))) {
        return null;
      }
      return [path, await workspace.fs.readFile(abs, "utf-8")] as const;
    })
  );
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (entry !== null) {
      files.set(entry[0], entry[1]);
    }
  }
  return files;
};

/** The preview of one checkout, over the pod the frame holds. `origin` is this
 * document's own origin, read when a start needs to check a URL against it —
 * the one origin a preview may occupy, and never a value passed over the wire
 * (the frame's URL is its own). `plan` and `start` are the preview runtime's
 * own two steps, handed in by the frame's entry (see `PreviewStarter`). */
export const createPreviewRuntime = (options: {
  origin: () => string;
  plan: PreviewPlanner;
  start: PreviewStarter;
}): PodPreviewRuntime => {
  const listeners = new Set<() => void>();
  const logListeners = new Set<(line: PodPreviewLog) => void>();
  let workspace: FrameWorkspace | null = null;
  let handle: PreviewHandle | null = null;
  let abort: AbortController | null = null;
  /** The panel is open. An `attach` that lands while it is (a ref change
   * remounts the browser and opens the next checkout) starts the preview too. */
  let wanted = false;
  /** Bumped by every stop: the answer of a superseded `startPreview` is stale,
   * and it stops itself instead of being adopted. */
  let generation = 0;
  let plan: PreviewPlan | null = null;
  let state: PreviewState | "idle" = "idle";
  let detail = "";
  let failure = "";
  let logs: PodPreviewLog[] = [];

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const view = (): PodPreviewView => ({
    detail,
    error: failure,
    logs: [...logs],
    plan,
    processes: handle?.processes() ?? [],
    state,
    // Only the running handle has a URL: between stop and the next start the
    // panel has nothing to frame.
    url: handle?.url ?? "",
  });

  const log = (text: string, stream: PodPreviewLog["stream"]): void => {
    const line = { stream, text };
    logs = [...logs, line].slice(-LOG_LIMIT);
    for (const listener of logListeners) {
      listener(line);
    }
    notify();
  };

  const setState = (next: PreviewState, nextDetail = ""): void => {
    state = next;
    detail = nextDetail;
    notify();
  };

  /** Plan and start, once per checkout: an open panel that is already running
   * (or still starting) is left alone. */
  const start = async (): Promise<void> => {
    const checkout = workspace;
    if (checkout === null || handle !== null || abort !== null) {
      return;
    }
    const mine = generation + 1;
    generation = mine;
    failure = "";
    logs = [];
    try {
      plan = options.plan(await readPlanFiles(checkout));
    } catch (error) {
      state = "error";
      failure = errorMessage(error);
      notify();
      return;
    }
    setState("installing", "Reading the app's configuration.");
    const controller = new AbortController();
    abort = controller;
    try {
      const started = await options.start(checkout.pod, plan, {
        onLog: (text, stream) => {
          if (mine === generation) {
            log(text, stream);
          }
        },
        onState: (next, nextDetail) => {
          if (mine === generation) {
            setState(next, nextDetail ?? "");
          }
        },
        signal: controller.signal,
      });
      if (mine !== generation) {
        await started.stop();
        return;
      }
      // Fail closed: a preview runs on the app's preview origin or not at all.
      // The pod boots with path URLs on this document's own origin, so a URL
      // that is not is either a different origin than this frame's (the boot
      // is wrong) or an attempt to frame something else — either way the panel
      // mounts no iframe.
      const previewOrigin = options.origin();
      const offOrigin = (url: string): boolean =>
        url !== previewOrigin && !url.startsWith(`${previewOrigin}/`);
      if (offOrigin(started.url)) {
        await started.stop();
        state = "error";
        detail = "";
        failure = `Preview stopped: its URL is not on the app's preview origin (expected ${previewOrigin}).`;
        notify();
        return;
      }
      handle = started;
      notify();
    } catch (error) {
      if (mine === generation) {
        state = "error";
        failure = errorMessage(error).trim() || "The preview failed to start.";
        notify();
      }
    } finally {
      if (abort === controller) {
        abort = null;
      }
    }
  };

  /** Stop whatever is running, including a start still in flight: the panel
   * closing must not leave a server or a build watcher behind. */
  const stop = async (): Promise<void> => {
    generation += 1;
    const controller = abort;
    abort = null;
    controller?.abort();
    const running = handle;
    handle = null;
    state = "idle";
    detail = "";
    if (running !== null) {
      try {
        await running.stop();
      } catch (error) {
        failure = errorMessage(error);
      }
    }
    notify();
  };

  return {
    attach: (checkout) => {
      workspace = checkout;
      if (wanted) {
        void start();
      }
    },
    close: async () => {
      wanted = false;
      await stop();
    },
    detach: async () => {
      workspace = null;
      await stop();
    },
    onLog: (listener) => {
      logListeners.add(listener);
      return () => {
        logListeners.delete(listener);
      };
    },
    open: async () => {
      wanted = true;
      await start();
    },
    restart: async () => {
      const running = handle;
      if (running === null) {
        await start();
        return;
      }
      failure = "";
      try {
        await running.restart();
      } catch (error) {
        // The server the restart halted is gone: the handle (and the URL it
        // frames) is stale, and a "Ready" over it would lie — same as a failed
        // start. Dropping it also makes the next restart start afresh.
        handle = null;
        state = "error";
        detail = "";
        failure = errorMessage(error);
        notify();
      }
    },
    stop,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view,
  };
};
