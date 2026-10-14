//! The frame's shell: the workspace's own terminal, created on the pod and
//! tapped to the page.
//!
//! The checkout is the shell's filesystem, so anything typed here is visible to
//! the tree and the editor by construction — that is why the terminal lives
//! where the pod does, and why the control page only sends it keystrokes and
//! draws what comes back. A dev server started from here is the pod's own
//! process, served through Nodepod's virtual routing like any other.

import type { Nodepod, NodepodTerminal } from "@r1ck404/nodepod";

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

/** Build the shell the SDK owns, tapped instead of rendered: `open` creates it
 * on the pod (nothing here can be built before the pod exists), and `close`
 * disposes it. */
export const createTerminalBackend = (options: {
  onWrite: (data: string) => void;
  pod: Nodepod;
}): TerminalBackend => {
  const { onWrite, pod } = options;
  let shell: NodepodTerminal | null = null;
  let tap: StubTerminal | null = null;
  let host: HTMLDivElement | null = null;

  return {
    close: () => {
      // `detach` disposes the tap it created (and the addons it loaded).
      shell?.detach();
      shell = null;
      tap = null;
      host?.remove();
      host = null;
    },
    input: (data) => {
      // Through the tap, which is where the SDK's own input handler is
      // attached: the keystroke takes exactly the path a renderer's would.
      tap?.feed(data);
    },
    open: (cols, rows) => {
      if (shell !== null) {
        return;
      }
      const next = pod.createTerminal({
        FitAddon: StubFitAddon,
        Terminal: stubTerminalClass(onWrite),
      });
      next.setCwd(PROJECT_ROOT);
      // The tap draws nothing, but it still needs somewhere to be "open": a
      // node in the frame's own document, hidden, that never lays out.
      const shellHost = document.createElement("div");
      shellHost.hidden = true;
      document.body.append(shellHost);
      next.attach(shellHost);
      // SAFETY: the SDK hands back the terminal this open built, whose
      // `Terminal` is this module's own stub.
      tap = next.xterm as StubTerminal;
      tap.resize(cols, rows);
      shell = next;
      host = shellHost;
    },
    resize: (cols, rows) => {
      tap?.resize(cols, rows);
    },
  };
};
