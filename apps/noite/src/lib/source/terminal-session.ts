/** The workspace's shell, drawn by ghostty-web — and nothing else. The shell
 * itself (Nodepod's terminal, the preview as its foreground job, the `preview`
 * custom command) runs in the pod frame on the app's preview origin; this
 * session is the display and the input: a ghostty `Terminal` plus `FitAddon`
 * on one host div that moves into the panel on mount and out of it on unmount,
 * keystrokes forwarded over the RPC, and every byte the frame's terminal
 * writes (prompt, echo, command output, the preview's logs) written back here
 * as it arrives. Hiding the panel therefore never touches the shell, its
 * scrollback or its processes. */

import { FitAddon, Terminal, init } from "ghostty-web";
import type { ITheme } from "ghostty-web";

import { errorMessage } from "../errors";
import type { PodConnection } from "./pod-client";

export interface TerminalLink {
  /** A checkout opened: the shell runs on its frame's terminal. */
  attach: (connection: PodConnection) => void;
  /** The frame is going away: close the shell and drop the canvas. */
  detach: () => Promise<void>;
}

/** What the panel draws: whether the shell is up, and why not. */
export interface TerminalView {
  error: string;
  ready: boolean;
}

export interface TerminalSession extends TerminalLink {
  /** The panel shown: put the (persistent) terminal into host, fit it. */
  mount: (host: HTMLElement) => Promise<void>;
  /** The panel hidden: take it out WITHOUT losing scrollback/shell state. */
  unmount: () => void;
  subscribe: (notify: () => void) => () => void;
  view: () => TerminalView;
}

/** ghostty's WASM, loaded once per page no matter how many sessions mount. */
let ghosttyReady: Promise<void> | null = null;

/** `init()` once; a failure clears the promise so the next mount retries. */
const ensureGhostty = async (): Promise<void> => {
  try {
    await (ghosttyReady ??= init());
  } catch (error) {
    ghosttyReady = null;
    throw error;
  }
};

/** The app's own monospace stack, so the shell reads like the editor. */
const TERMINAL_FONT =
  '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Shell text a notch under the editor's, for a dense but readable grid. */
const TERMINAL_FONT_SIZE = 13;

/** How many lines the canvas keeps behind the cursor. */
const TERMINAL_SCROLLBACK = 5000;

/** One daisyUI variable as `#rrggbb`: daisyUI's colors are `oklch(…)`, which
 * ghostty cannot parse, and a computed style keeps them in oklch. A probe
 * element resolves the variable, and a 1×1 canvas converts whatever color it
 * names into sRGB bytes — the one form ghostty reads in every browser. */
const resolveVar = (name: string, fallback: string): string => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name}, ${fallback})`;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement("canvas").getContext("2d");
  if (resolved === "" || context === null) {
    return fallback;
  }
  context.fillStyle = resolved;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/** The terminal's colors, from the page's own theme: read on every mount, so
 * a light/dark flip while the panel was hidden still lands. */
const readTheme = (): ITheme => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    background: resolveVar("--color-base-100", dark ? "#141414" : "#ffffff"),
    foreground: resolveVar(
      "--color-base-content",
      dark ? "#f2f2f2" : "#1a1a1a"
    ),
  };
};

/** A shell on one frame, as the panel drives it: ghostty's renderer over the
 * frame's terminal RPC. */
export const createTerminalSession = (): TerminalSession => {
  const listeners = new Set<() => void>();
  let connection: PodConnection | null = null;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  /** The shell's own div: the canvas lives on this element, which moves into
   * the panel on mount and out of it on unmount. */
  let shell: HTMLDivElement | null = null;
  /** Where `shell` sits while mounted; remembered so a checkout that lands
   * mid-mount (a ref change under a standing panel) rebuilds in place. */
  let panel: HTMLElement | null = null;
  /** The attach generation: a frame that lands mid-build supersedes it, and
   * the superseded build bails at its next checkpoint instead of half-mounting
   * a dead frame's shell. */
  let epoch = 0;
  let creating: Promise<void> | null = null;
  let observer: ResizeObserver | null = null;
  let ready = false;
  let failure = "";
  /** What the frame's terminal wrote and the canvas has not drawn yet: one
   * write per animation frame, never one per chunk. */
  let pending = "";
  let frame = 0;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const view = (): TerminalView => ({ error: failure, ready });

  /** Draw everything the frame wrote since the last paint. */
  const flush = (): void => {
    frame = 0;
    const chunk = pending;
    pending = "";
    if (chunk !== "") {
      terminal?.write(chunk);
    }
  };

  /** Tear the canvas down; the frame (and the panel) stay. */
  const disposeShell = (): void => {
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    pending = "";
    observer?.disconnect();
    observer = null;
    fitAddon?.dispose();
    fitAddon = null;
    terminal?.dispose();
    terminal = null;
    shell?.remove();
    shell = null;
    ready = false;
  };

  /** Build the shell on `mine`'s frame and put it in `panel`. A frame that
   * lands mid-build supersedes it, and the build bails instead of half-
   * mounting a dead frame's shell. The previous shell is disposed after the
   * last await, so overlapping builds converge on the newest frame. */
  const create = async (mine: number): Promise<void> => {
    const opened = connection;
    const host = panel;
    if (opened === null || host === null) {
      return;
    }
    try {
      await ensureGhostty();
      if (mine !== epoch || connection !== opened || panel !== host) {
        return;
      }
      disposeShell();
      const next = new Terminal({
        fontFamily: TERMINAL_FONT,
        fontSize: TERMINAL_FONT_SIZE,
        scrollback: TERMINAL_SCROLLBACK,
        theme: readTheme(),
      });
      const addon = new FitAddon();
      next.loadAddon(addon);
      const shellHost = document.createElement("div");
      shellHost.style.height = "100%";
      shellHost.style.width = "100%";
      host.append(shellHost);
      next.open(shellHost);
      shell = shellHost;
      terminal = next;
      fitAddon = addon;
      next.onData((data) => {
        void opened.call("terminal.input", { data });
      });
      next.onResize(({ cols, rows }) => {
        void opened.call("terminal.resize", { cols, rows });
      });
      addon.fit();
      await opened.call("terminal.open", { cols: next.cols, rows: next.rows });
      if (mine !== epoch || connection !== opened) {
        return;
      }
      ready = true;
      failure = "";
      observer = new ResizeObserver(() => {
        addon.fit();
      });
      observer.observe(host);
      // The panel may still be laying out: fit again on the next frame.
      requestAnimationFrame(() => addon.fit());
    } catch (error) {
      failure = errorMessage(error);
      ready = false;
    }
    notify();
  };

  /** Run `create` once per burst of mounts: concurrent mounts (ilha hands
   * every render a `ref`, scratch copies included) share the one build. Only
   * the current generation clears the tracker — a superseded build must not
   * orphan its replacement. */
  const buildShell = async (mine: number): Promise<void> => {
    try {
      await create(mine);
    } finally {
      if (mine === epoch) {
        creating = null;
      }
    }
  };

  /** Everything the frame's shell writes, buffered to one canvas write per
   * animation frame: a prompt, an echo, a command's output and the preview's
   * foreground job all arrive here. */
  const stopWrites = (opened: PodConnection): (() => void) =>
    opened.on("terminal.write", ({ data }) => {
      pending += data;
      frame ||= requestAnimationFrame(flush);
    });

  let unwatch: (() => void) | null = null;

  return {
    attach: (opened) => {
      unwatch?.();
      connection = opened;
      unwatch = stopWrites(opened);
      failure = "";
      // A frame that lands while mounted (a ref change remounts the browser
      // under a standing panel) rebuilds the shell in place: the old frame,
      // and the shell in it, go away. The generation abandons any build the
      // previous frame started — it bails at its next checkpoint — and a fresh
      // build takes its place (never a reused stale one).
      if (panel !== null) {
        epoch += 1;
        disposeShell();
        creating = buildShell(epoch);
        void creating;
      }
      notify();
    },
    detach: async () => {
      const opened = connection;
      connection = null;
      unwatch?.();
      unwatch = null;
      creating = null;
      disposeShell();
      notify();
      if (opened !== null) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- the protocol's paramless kinds still take their (undefined) params slot.
        await opened.call("terminal.close", undefined);
      }
    },
    mount: (host) => {
      panel = host;
      const running = terminal;
      if (running !== null) {
        // A remount: the shell survived hidden — move it back in, relearn
        // the theme (light/dark may have flipped), and refit.
        const parked = shell;
        if (parked !== null && parked.parentElement !== host) {
          host.append(parked);
        }
        running.options.theme = readTheme();
        fitAddon?.fit();
        requestAnimationFrame(() => fitAddon?.fit());
        return Promise.resolve();
      }
      // Mounting before the frame lands (the panel paints long before the
      // workspace opens) is the normal order, not an error: `attach` builds
      // once the frame is here.
      if (connection === null) {
        return Promise.resolve();
      }
      creating ??= buildShell(epoch);
      return creating;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    unmount: () => {
      panel = null;
      // Out of the panel, not out of existence: the div keeps the canvas, its
      // scrollback and its shell, and the next mount moves it back.
      shell?.remove();
    },
    view,
  };
};
