//! The frame's shell: the workspace's own terminal, created on the pod and
//! tapped to the page.
//!
//! The checkout is the shell's filesystem, so anything typed here is visible to
//! the tree and the editor by construction — that is why the terminal lives
//! where the pod does, and why the control page only sends it keystrokes and
//! draws what comes back. A dev server started from here is the pod's own
//! process, served through Nodepod's virtual routing like any other.
//!
//! The shell's own lifecycle is `BackendState` below: `closed` until `open`
//! created it on the pod, `open` until `close` took it down. Input and resize
//! are only applied in `open`, so a keystroke that races `open` (or lands after
//! `close`) is refused by the state instead of being swallowed by an optional
//! chain.

import type { Nodepod, NodepodTerminal } from "@r1ck404/nodepod";
import { Data } from "effect";

import { PROJECT_ROOT } from "../lib/source/workspace/types";
import type { StubTerminal } from "./stub-terminal";
import { StubFitAddon, stubTerminalClass } from "./stub-terminal";

/** One shell on one pod, as the frame drives it: keystrokes in, everything the
 * shell says out through `onWrite`. */
export interface TerminalBackend {
  /** The panel closed (or the frame is going): take the shell down. */
  close: () => void;
  /** Keystrokes from the page, exactly as typed. */
  input: (data: string) => void;
  /** The shell exists now; `cols`/`rows` are the page's grid. */
  open: (cols: number, rows: number) => void;
  /** The page was resized: the pod's processes have to hear about it. */
  resize: (cols: number, rows: number) => void;
}

/** The shell on the pod.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> closed
 *   closed --> open: open(cols, rows)
 *   open --> open: resize
 *   open --> closed: close
 * ```
 *
 * The SDK handles live inside `open`, so "there is a shell" and "the frame has
 * a terminal" are the same fact. */
export type BackendState = Data.TaggedEnum<{
  Closed: Record<never, never>;
  Open: {
    host: HTMLDivElement;
    shell: NodepodTerminal;
    tap: StubTerminal;
  };
}>;

export const Backend = Data.taggedEnum<BackendState>();

/** Build the shell the SDK owns, tapped instead of rendered: `open` creates it
 * on the pod (nothing here can be built before the pod exists), and `close`
 * disposes it. */
export const createTerminalBackend = (options: {
  onWrite: (data: string) => void;
  pod: Nodepod;
}): TerminalBackend => {
  const { onWrite, pod } = options;
  let state: BackendState = Backend.Closed();

  return {
    close: () => {
      if (Backend.$is("Closed")(state)) {
        return;
      }

      const { host, shell } = state;
      // `detach` disposes the tap it created (and the addons it loaded).
      shell.detach();
      host.remove();
      state = Backend.Closed();
    },
    input: (data) => {
      // Through the tap, which is where the SDK's own input handler is
      // attached: the keystroke takes exactly the path a renderer's would.
      if (Backend.$is("Open")(state)) {
        state.tap.feed(data);
      }
    },
    open: (cols, rows) => {
      if (Backend.$is("Open")(state)) {
        return;
      }

      const shell = pod.createTerminal({
        FitAddon: StubFitAddon,
        Terminal: stubTerminalClass(onWrite),
      });

      shell.setCwd(PROJECT_ROOT);
      // The tap draws nothing, but it still needs somewhere to be "open": a
      // node in the frame's own document, hidden, that never lays out.
      const host = document.createElement("div");
      host.hidden = true;
      document.body.append(host);
      shell.attach(host);
      // SAFETY: the SDK hands back the terminal this open built, whose
      // `Terminal` is this module's own stub.
      const tap = shell.xterm as StubTerminal;
      tap.resize(cols, rows);
      state = Backend.Open({ host, shell, tap });
    },
    resize: (cols, rows) => {
      if (Backend.$is("Open")(state)) {
        state.tap.resize(cols, rows);
      }
    },
  };
};
