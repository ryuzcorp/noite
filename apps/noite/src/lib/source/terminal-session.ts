/** The workspace's shell, drawn by ghostty-web — and nothing else. The shell
 * itself (Nodepod's terminal) runs in the pod frame on the app's pod host
 * origin; this session is the display and the input: a ghostty `Terminal` plus
 * `FitAddon` on one host div that moves into the panel on mount and out of it
 * on unmount, keystrokes forwarded over the RPC, and every byte the frame's
 * terminal writes (prompt, echo, command output) written back here as it
 * arrives. Hiding the panel therefore never touches the shell, its scrollback
 * or its processes. */

import type { FitAddon, ITheme, Terminal, init } from "ghostty-web";

import { errorMessage } from "../errors";
import type { PodConnection } from "./pod-client";

export interface TerminalLink {
  /** A checkout opened, or a switch landed on another checkout: the shell runs
   * on `connection`'s frame's terminal. A shell already on another frame is
   * rebuilt (`attach`), which is why the caller detaches first (see below). */
  attach: (connection: PodConnection) => void;
  /** Let go of the shell `connection` holds: the canvas goes, and the frame's
   * own terminal closes. A connection that is not the one the shell is on is
   * left alone — a switch attaches the new checkout before the old one is
   * dropped, and that late teardown must not close the shell the user sees. */
  detach: (connection: PodConnection) => Promise<void>;
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

/** The renderer, fetched when the first shell is built rather than with the
 * page: ghostty inlines its own WASM, so a static import would land it in the
 * entry chunk every route loads — the terminal is opt-in (`?terminal=1`) and
 * Code mode's first paint must not wait on it. */
interface GhosttyModule {
  FitAddon: typeof FitAddon;
  Terminal: typeof Terminal;
  init: typeof init;
}

let ghosttyModule: Promise<GhosttyModule> | null = null;

/** ghostty's WASM, loaded once per page no matter how many sessions mount. */
let ghosttyReady: Promise<void> | null = null;

/** The module, then `init()` once; a failure clears both so the next mount
 * retries. */
const ensureGhostty = async (): Promise<GhosttyModule> => {
  const module = await (ghosttyModule ??= import("ghostty-web"));
  try {
    await (ghosttyReady ??= module.init());
  } catch (error) {
    ghosttyReady = null;
    throw error;
  }
  return module;
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

/** Draw the whole grid again, from the buffer the frame wrote. ghostty's own
 * render loop (`Terminal.open` starts it) repaints only the rows its WASM
 * render state reports dirty — `CanvasRenderer.render(…, forceAll, …)` with
 * `forceAll` false draws the `isRowDirty()` rows plus the cursor — and ends
 * every render with `clearDirty()`, so the loop never redraws a canvas that
 * lost its pixels: a canvas throws its bitmap away whenever its `width`/`height`
 * is assigned, which is what a resize does (`Terminal.resize`), and the panel
 * then shows a blank grid until the shell's next write dirties a row — a
 * prompt, an echo, a command's output. `renderer` and `wasmTerm` are ghostty's
 * public fields and `forceAll` is its own redraw-everything flag (the one
 * `Terminal.resize` passes), so this is the supported way to draw the grid the
 * canvas is missing; the scrollbar opacity is 0 because the loop owns that
 * fade. */
const repaint = (drawn: Terminal): void => {
  const { renderer, wasmTerm: buffer } = drawn;
  if (renderer === undefined || buffer === undefined) {
    return;
  }
  renderer.render(buffer, true, drawn.viewportY, drawn, 0);
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
  /** The frame-paced fit a mount arms (see `refitSoon`): the panel's box is
   * only real a frame after the shell moves back into it. */
  let fitting = 0;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const view = (): TerminalView => ({ error: failure, ready });

  /** Measure the shell's box and draw the grid, now. The fit addon leaves the
   * grid alone when its container cannot be measured (`clientWidth`/
   * `clientHeight` 0 — the shell out of the document, a panel not laid out
   * yet), and `Terminal.resize` returns early when the grid already has the
   * size proposed, so a fit alone can leave the canvas as it found it. The
   * repaint covers that; the fit is what sends new cols/rows to the pod's
   * shell through the session's own `onResize` handler when the box did
   * change. */
  const refit = (): void => {
    fitAddon?.fit();
    if (terminal !== null) {
      repaint(terminal);
    }
  };

  /** The frame-paced fit: drop the handle, then measure (the frame itself is
   * what `fitting` stands for). */
  const refitFrame = (): void => {
    fitting = 0;
    refit();
  };

  /** Fit now and once more on the next frame: the panel's box is only real
   * after the browser has laid the new pane out, which is the frame after the
   * mount. */
  const refitSoon = (): void => {
    refit();
    if (fitting === 0) {
      fitting = requestAnimationFrame(refitFrame);
    }
  };

  /** Watch the pane the shell sits in: it is a fresh element per panel mount
   * (the shadow pane is built with the panel, and the shell moves into it),
   * and its box changes when the panel opens, when the editor or the side
   * panel takes another share and when the window resizes — every one of
   * those has to be measured again. The observer follows the live pane, so
   * the one disposed with its panel is dropped here. */
  const watch = (host: HTMLElement): void => {
    observer ??= new ResizeObserver(() => {
      refit();
    });
    observer.disconnect();
    observer.observe(host);
  };

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
    if (fitting !== 0) {
      cancelAnimationFrame(fitting);
      fitting = 0;
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
      const ghostty = await ensureGhostty();
      if (mine !== epoch || connection !== opened || panel !== host) {
        return;
      }
      disposeShell();
      const next = new ghostty.Terminal({
        fontFamily: TERMINAL_FONT,
        fontSize: TERMINAL_FONT_SIZE,
        scrollback: TERMINAL_SCROLLBACK,
        theme: readTheme(),
      });
      const addon = new ghostty.FitAddon();
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
      // The grid starts at the size ghostty opened with (its own default
      // until a fit runs): measure the pane, draw it, and report the size to
      // the pod before it builds the shell, so the prompt it prints is the
      // size the user sees.
      watch(host);
      refit();
      await opened.call("terminal.open", { cols: next.cols, rows: next.rows });
      if (mine !== epoch || connection !== opened) {
        return;
      }
      ready = true;
      failure = "";
      // The panel may still be laying out: fit again on the next frame.
      refitSoon();
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
   * animation frame: a prompt, an echo and a command's output all arrive here. */
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
    detach: async (opened) => {
      if (connection !== opened) {
        // The shell moved to another checkout (a switch landed): this frame is
        // not the one the canvas is on, and closing its terminal is the frame's
        // own teardown's business.
        return;
      }
      connection = null;
      unwatch?.();
      unwatch = null;
      creating = null;
      disposeShell();
      notify();
      try {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- the protocol's paramless kinds still take their (undefined) params slot.
        await opened.call("terminal.close", undefined);
      } catch {
        // A frame that is already gone (a fatal closed its port, or the pod
        // died) refuses this; the shell is off it either way, and the frame's
        // own teardown closes the terminal it still holds.
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
        // The pane is new (it was built with this panel), so the shell's box
        // is not the one it was fitted to: watch it, measure it now and again
        // once it has been laid out, and repaint — the canvas came from a
        // hidden grid and nothing else redraws it on show.
        watch(host);
        refitSoon();
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
      // The pane this observed went away with the panel, and the shell is out
      // of the document (nothing to measure, nothing to draw): the next mount
      // points the observer at the pane it moves the shell into.
      observer?.disconnect();
      if (fitting !== 0) {
        cancelAnimationFrame(fitting);
        fitting = 0;
      }
      // Out of the panel, not out of existence: the div keeps the canvas, its
      // scrollback and its shell, and the next mount moves it back.
      shell?.remove();
    },
    view,
  };
};
