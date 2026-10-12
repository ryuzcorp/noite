/** The Preview panel's life, with none of its markup. The preview — its plan,
 * its installs, its servers, its processes — runs in the pod frame on the
 * app's preview origin, driven by `preview.open`/`close`/`restart`/`stop`; the
 * frame streams `preview.state` and `preview.log` events, and this session
 * holds what the panel draws from them. The browser attaches its frame when
 * the checkout opens and detaches it when the checkout closes; the panel opens
 * the preview when the user opens the panel and closes it when the user closes
 * it. */

import { errorMessage } from "../errors";
import type { PodConnection } from "./pod-client";
import type {
  PodPreviewLog,
  PodPreviewStateEvent,
  PodPreviewView,
} from "./pod-protocol";
import type { PreviewPlan, PreviewState } from "./preview/types";

/** What the panel says when the app's preview origin could not be established:
 * an empty answer is not "this app needs no separate origin", it is one that
 * cannot be given, and a preview that ran anyway would run on this page's own
 * origin — the thing the separate origin exists to prevent. */
const PREVIEW_ORIGIN_MISSING =
  "Preview cannot start: the app's preview origin could not be read, and a preview must not run on this page's own origin.";

/** How much of the preview's own output the panel keeps: an install or a build
 * can print more than a pane can hold, and the last lines are the ones that
 * say why it failed. */
const LOG_LIMIT = 500;

/** Everything the panel draws. `state` is `"idle"` before the panel has ever
 * started the preview, and `plan` is null until the frame has planned. */
export interface PreviewView {
  /** What the current state is doing — the detail the frame last reported. */
  detail: string;
  /** The failure, verbatim — a start that threw, a restart that did, or a call
   * this page could not deliver. */
  error: string;
  logs: PodPreviewLog[];
  plan: PreviewPlan | null;
  /** The preview's live child processes, oldest first — the terminal's
   * `preview` command reads these. Empty when nothing runs. */
  processes: string[];
  state: PreviewState | "idle";
  /** The running preview's URL: what the panel's iframe loads. */
  url: string;
}

/** What the browser needs of the session: the app's preview origin (the frame
 * — and the whole pod — lives there, so the workspace cannot open without it),
 * and where its checkout's frame goes while it is open. */
export interface PreviewLink {
  attach: (connection: PodConnection) => void;
  /** Stop the preview and forget the frame; the browser awaits it before it
   * tears the workspace down, so no server is left on a closed frame. */
  detach: () => Promise<void>;
  /** The app's preview origin, read once per session. Rejects with the reason
   * when it could not be read, and answers `""` when there is none (see
   * `PREVIEW_ORIGIN_MISSING`). */
  origin: () => Promise<string>;
}

export interface PreviewSession extends PreviewLink {
  /** The panel closed: stop the preview's processes and ports. */
  close: () => Promise<void>;
  /** The panel opened: plan and start, once per frame. */
  open: () => Promise<void>;
  /** Every line the preview prints, as it prints it. */
  onLog: (listener: (line: PodPreviewLog) => void) => () => void;
  /** Restart the preview's server in place. */
  restart: () => Promise<void>;
  /** Stop the preview's processes now — Ctrl+C in the terminal and its
   * `preview stop` command. The panel (or `restart`) starts it again. */
  stop: () => Promise<void>;
  subscribe: (notify: () => void) => () => void;
  view: () => PreviewView;
}

/** The four things the panel asks of a frame's preview. */
type PreviewVerb =
  | "preview.close"
  | "preview.open"
  | "preview.restart"
  | "preview.stop";

/** The state every snapshot starts from: nothing planned, nothing running. */
const IDLE_STATE: PodPreviewStateEvent = {
  detail: "",
  error: "",
  plan: null,
  processes: [],
  state: "idle",
  url: "",
};

/** A preview of one frame, as the panel drives it: the frame's own snapshot,
 * the log, and the failure this page added. */
export const createPreviewSession = (options: {
  /** The app's preview origin (`sourcePreviewOrigin` → `previewHost(slug)`),
   * read when the browser first asks for it. */
  origin: () => Promise<string>;
}): PreviewSession => {
  const listeners = new Set<() => void>();
  const logListeners = new Set<(line: PodPreviewLog) => void>();
  let connection: PodConnection | null = null;
  let stopState: (() => void) | null = null;
  let stopLog: (() => void) | null = null;
  /** The panel is open. An `attach` that lands while it is (a ref change
   * remounts the browser and opens the next checkout) starts the preview too. */
  let wanted = false;
  let plan: PodPreviewStateEvent = IDLE_STATE;
  let logs: PodPreviewLog[] = [];
  /** The failure this page added: a call the frame refused or never answered,
   * or an origin that could not be read. It outranks the frame's own `error`
   * until something succeeds. */
  let failure = "";
  /** The preview origin, read once per session (it is per app, not per frame)
   * and only when something needs it. */
  let originRequest: Promise<string> | null = null;
  let resolvedOrigin = "";

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const view = (): PreviewView => {
    if (failure !== "") {
      return {
        detail: "",
        error: failure,
        logs: [...logs],
        plan: plan.plan,
        processes: [],
        state: "error",
        url: "",
      };
    }
    return {
      detail: plan.detail,
      error: plan.error,
      logs: [...logs],
      plan: plan.plan,
      processes: plan.processes,
      state: plan.state,
      url: plan.url,
    };
  };

  /** Whether a URL is on the app's preview origin. Fail closed: guest code
   * must never run on the control UI's origin, and a URL the pod answered with
   * is the one place that could happen. */
  const onPreviewOrigin = (url: string): boolean =>
    url === resolvedOrigin || url.startsWith(`${resolvedOrigin}/`);

  /** Take the frame's snapshot: it is the truth about the preview, except for
   * a URL that left the preview origin. */
  const adopt = (next: PodPreviewStateEvent): void => {
    failure = "";
    if (next.url !== "" && !onPreviewOrigin(next.url)) {
      failure = `Preview stopped: its separate origin did not connect (expected ${resolvedOrigin}).`;
      plan = { ...next, detail: "", processes: [], state: "error", url: "" };
      return;
    }
    plan = next;
  };

  /** The app's preview origin, read once per session. A read that failed
   * rejects with its own reason (the page's closure says why); an origin that
   * is empty is answered as such, and `start` refuses it. */
  const resolveOrigin = async (): Promise<string> => {
    originRequest ??= options.origin();
    try {
      resolvedOrigin = await originRequest;
      return resolvedOrigin;
    } catch (error) {
      const reason = errorMessage(error);
      failure = reason;
      throw new Error(reason, { cause: error });
    }
  };

  /** One preview verb: the frame answers with the snapshot after it, and a
   * call that failed leaves the panel saying so rather than showing a preview
   * the frame does not have. */
  const run = async (
    opened: PodConnection,
    verb: PreviewVerb
  ): Promise<void> => {
    try {
      // No deadline: an install and a build can take minutes, and the frame
      // reports every step of them as events while this waits.
      const next: PodPreviewView = await opened.call(verb, undefined, {
        timeout: 0,
      });
      if (connection === opened) {
        adopt(next);
      }
    } catch (error) {
      if (connection === opened) {
        failure = errorMessage(error);
      }
    }
    notify();
  };

  /** Start the preview on the attached frame, once: an open panel that is
   * already running is left alone (the frame's own `preview.open` is
   * idempotent per checkout). */
  const start = async (): Promise<void> => {
    const opened = connection;
    if (opened === null) {
      return;
    }
    if (resolvedOrigin === "") {
      try {
        await resolveOrigin();
      } catch {
        notify();
        return;
      }
    }
    if (resolvedOrigin === "") {
      failure = PREVIEW_ORIGIN_MISSING;
      notify();
      return;
    }
    await run(opened, "preview.open");
  };

  /** Forget the frame's state (its preview is gone with the frame). */
  const reset = (): void => {
    plan = IDLE_STATE;
    failure = "";
  };

  return {
    attach: (opened) => {
      stopState?.();
      stopLog?.();
      connection = opened;
      stopState = opened.on("preview.state", (next) => {
        if (connection === opened) {
          adopt(next);
          notify();
        }
      });
      stopLog = opened.on("preview.log", (line) => {
        if (connection !== opened) {
          return;
        }
        logs = [...logs, line].slice(-LOG_LIMIT);
        for (const listener of logListeners) {
          listener(line);
        }
        notify();
      });
      failure = "";
      if (wanted) {
        void start();
      }
      notify();
    },
    close: async () => {
      wanted = false;
      const opened = connection;
      if (opened === null) {
        reset();
        notify();
        return;
      }
      await run(opened, "preview.close");
    },
    detach: async () => {
      wanted = false;
      const opened = connection;
      connection = null;
      stopState?.();
      stopLog?.();
      stopState = null;
      stopLog = null;
      if (opened !== null) {
        try {
          await opened.call("preview.close", undefined, { timeout: 0 });
        } catch {
          // The frame is going away: its preview goes with it.
        }
      }
      reset();
      notify();
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
    origin: resolveOrigin,
    restart: async () => {
      const opened = connection;
      if (opened === null) {
        await start();
        return;
      }
      await run(opened, "preview.restart");
    },
    stop: async () => {
      const opened = connection;
      if (opened === null) {
        return;
      }
      await run(opened, "preview.stop");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view,
  };
};
