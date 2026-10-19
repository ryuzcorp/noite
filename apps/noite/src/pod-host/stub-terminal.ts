/* oxlint-disable eslint/max-classes-per-file, eslint/class-methods-use-this -- the tap is three shapes of one thing (the terminal, the fit addon xterm's API demands, and the per-session subclass the SDK constructs), and the fit addon's `fit` is an instance method because the SDK calls it on one. */
//! The pod's shell, tapped instead of drawn.
//!
//! The frame runs Nodepod's own terminal — the SDK's line editing, history,
//! tab completion, the shell's process wiring — but it must not draw anything:
//! the pane the user types into is the control page's ghostty renderer, on the
//! other side of the RPC. So the frame hands `createTerminal` a `Terminal` of
//! this module's making: everything xterm.js is asked for while a command is
//! being edited is answered here, and every byte the SDK would have rendered
//! goes to `onWrite` instead, which the frame streams to the page as
//! `terminal.write` events.
//!
//! The surface is exactly what the pinned SDK (1.11.2) touches on the object it
//! is handed as `Terminal`: the constructor's options, `options.theme`,
//! `loadAddon`, `open`, `write`, `writeln`, `clear`, `focus`, `onData`,
//! `onResize`, `cols`, `rows` and `dispose`. This module adds one more —
//! `resize` — because the size is the *page's* to know: `terminal.open` and
//! `terminal.resize` carry it here, and firing the resize listeners is what
//! tells the pod's processes their new columns and rows.

import type { TerminalTheme } from "@r1ck404/nodepod";

/** One addon as the tap holds it: the SDK loads its fit addon and, if it was
 * given one, its serialize addon; only `dispose` is ever read. */
export interface TapAddon {
  dispose?: () => void;
}

/** The options the SDK constructs the terminal with (see `attach` in
 * `nodepod-terminal.js`): the tap renders none of them, but xterm's own
 * `options` bag is mutable and the SDK writes the theme into it. */
export interface StubTerminalOptions {
  cursorBlink?: boolean;
  fontFamily?: string;
  fontSize?: number;
  theme?: TerminalTheme;
}

/** What `onData` and `onResize` hand back (xterm's own disposable shape). */
export interface TapDisposable {
  dispose: () => void;
}

/** What clears a terminal: erase the whole screen and home the cursor, which
 * is what xterm's `clear()` looks like on the wire and what every renderer
 * (ghostty included) understands. */
const CLEAR = "\u001B[2J\u001B[H";

/** xterm's default grid. The real size arrives with the first `resize` (the
 * page's `terminal.open`), before anything is written. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** The terminal the pod's shell is written to: a tap, never a renderer. Each
 * write goes to `onWrite` **and** is kept in `output`, so a test can read what
 * the shell said without a renderer to look at. */
export class StubTerminal {
  /** The page's grid, as of the last `resize`. */
  cols = DEFAULT_COLS;
  rows = DEFAULT_ROWS;
  /** xterm's own mutable options bag: the SDK assigns `theme` here. */
  readonly options: { theme: TerminalTheme | undefined };
  /** What `open` was handed — the frame's hidden host, in the tests. */
  target: Element | string | null = null;
  /** Whether the SDK last asked for focus (nothing to focus without a
   * renderer, but the test can watch it). */
  focused = false;
  /** Everything written, in order: the shell's transcript. */
  readonly output: string[] = [];
  private readonly addons: TapAddon[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<() => void>();
  private readonly sink: (text: string) => void;
  private disposed = false;

  constructor(options: StubTerminalOptions, sink: (text: string) => void) {
    this.options = { theme: options.theme };
    this.sink = sink;
  }

  /** A write from the SDK: the echo of a keystroke, a prompt, a process's
   * output. A terminal that is already gone says nothing. */
  write(text: string): void {
    if (this.disposed) {
      return;
    }

    this.output.push(text);
    this.sink(text);
  }

  writeln(text: string): void {
    this.write(`${text}\r\n`);
  }

  clear(): void {
    this.write(CLEAR);
  }

  focus(): void {
    this.focused = true;
  }

  loadAddon(addon: TapAddon): void {
    this.addons.push(addon);
  }

  onData(listener: (data: string) => void): TapDisposable {
    this.dataListeners.add(listener);

    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  /** A keystroke the page sent: what xterm would deliver to `onData` when the
   * user typed in it, so the SDK's own line editing runs exactly as it would
   * with a renderer attached. */
  feed(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  onResize(listener: () => void): TapDisposable {
    this.resizeListeners.add(listener);

    return {
      dispose: () => {
        this.resizeListeners.delete(listener);
      },
    };
  }

  /** The page's grid: the columns and rows the SDK reads back when the pod's
   * processes have to be told their window changed. */
  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }

    this.cols = cols;
    this.rows = rows;

    for (const listener of this.resizeListeners) {
      listener();
    }
  }

  open(target: Element | string): void {
    this.target = target;
  }

  dispose(): void {
    this.disposed = true;
    this.dataListeners.clear();
    this.resizeListeners.clear();

    for (const addon of this.addons.splice(0)) {
      addon.dispose?.();
    }
  }
}

/** The `Terminal` class one session hands the SDK: the SDK constructs it
 * itself, from options only, so the sink — the session's own `terminal.write`
 * stream — is closed over here rather than passed in. */
export const stubTerminalClass = (
  sink: (text: string) => void
): new (options: StubTerminalOptions) => StubTerminal =>
  class extends StubTerminal {
    constructor(options: StubTerminalOptions) {
      super(options, sink);
    }
  };

/** The fit addon the SDK is given: xterm's fit addon measures the renderer and
 * resizes the grid, and this tap has neither. The size is the page's, so a fit
 * has nothing to do here — the listeners the SDK attached are fired by
 * `StubTerminal.resize` when the page reports one. */
export class StubFitAddon {
  fit(): void {
    // Nothing to measure: see the class comment.
  }
}
