//! The frame's shell: the workspace's own terminal, created on the pod and
//! tapped to the page.
//!
//! The checkout is the shell's filesystem, so anything typed here is visible to
//! the tree, the editor and the preview by construction — that is why the
//! terminal lives where the pod does, and why the control page only sends it
//! keystrokes and draws what comes back.
//!
//! The running preview is the shell's foreground job: its output streams into
//! the terminal, typing goes nowhere while it runs, and Ctrl+C stops it and
//! gives the prompt back — like `npm run dev` in a local terminal. That wiring
//! is the SDK's (`NodepodTerminal._wireExecution`), so it is wrapped here: the
//! preview's state decides what the shell's foreground is, and a command the
//! user typed keeps the prompt until it has answered.

import type { Nodepod, NodepodTerminal } from "@r1ck404/nodepod";

import type { PodPreviewLog, PodPreviewView } from "../lib/source/pod-protocol";
import { PROJECT_ROOT } from "../lib/source/workspace/types";
import type { PodPreviewRuntime } from "./preview-runtime";
import type { StubTerminal } from "./stub-terminal";
import { StubFitAddon, stubTerminalClass } from "./stub-terminal";

/** What the pod's `createTerminal` wires into its terminal, as far as this
 * backend wraps it (`TerminalWiring` in the SDK, which its entry point does
 * not export). */
interface ShellWiring {
  getActiveAbort: () => AbortController | null;
  getIsStdinRaw: () => boolean;
  getSendStdin: () => ((data: string) => void) | null;
  onCommand: (cmd: string) => Promise<void>;
  setActiveAbort: (controller: AbortController | null) => void;
}

/** How each stream of the preview's output is drawn: its own lines plain, its
 * errors red, the runtime's commentary dim. */
const LOG_STYLE: Record<PodPreviewLog["stream"], [string, string]> = {
  stderr: ["\u001B[31m", "\u001B[0m"],
  stdout: ["", ""],
  system: ["\u001B[2m", "\u001B[0m"],
};

const LINE_BREAK = /\r?\n/gu;

/** The states in which the preview holds the shell's foreground. */
const isRunning = (state: PodPreviewView["state"]): boolean =>
  state !== "idle" && state !== "error";

/** One shell on one pod, as the frame drives it: keystrokes in, everything the
 * shell says out through `onWrite`, and the preview as its foreground job. */
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
 * disposes it and stops listening to the preview. */
export const createTerminalBackend = (options: {
  onWrite: (data: string) => void;
  pod: Nodepod;
  preview: PodPreviewRuntime;
}): TerminalBackend => {
  const { onWrite, pod, preview } = options;
  let shell: NodepodTerminal | null = null;
  let tap: StubTerminal | null = null;
  let host: HTMLDivElement | null = null;
  /** The preview's place as the shell's foreground job: aborting it (Ctrl+C,
   * through the wiring below) stops the preview. Null while the shell has the
   * prompt. */
  let job: AbortController | null = null;
  /** A command the user typed is running: the preview waits for the prompt
   * before it takes the foreground. */
  let busy = false;

  /** One line of the preview's output, in the terminal's own line breaks. */
  const writeLog = (line: PodPreviewLog): void => {
    const [open, close] = LOG_STYLE[line.stream];
    shell?.write(`${open}${line.text.replace(LINE_BREAK, "\r\n")}${close}\r\n`);
  };

  /** Put the preview in the foreground or give the prompt back, whichever its
   * state now calls for. The job starts at the prompt as if `preview` had been
   * typed, replays what the preview printed so far, and holds the shell until
   * the preview stops — by Ctrl+C here, or anywhere else (the Preview panel
   * closing, a crash). */
  const syncJob = (): void => {
    const running = shell;
    if (running === null || busy) {
      return;
    }
    const current = preview.view();
    if (job === null && isRunning(current.state)) {
      const controller = new AbortController();
      job = controller;
      controller.signal.addEventListener(
        "abort",
        () => {
          // Ctrl+C: the terminal itself prints `^C` and the prompt.
          job = null;
          void preview.stop();
        },
        { once: true }
      );
      running.write("preview\r\n");
      for (const line of current.logs) {
        writeLog(line);
      }
      running._setRunning(true);
      return;
    }
    if (job !== null && !isRunning(current.state)) {
      job = null;
      const reason = current.error === "" ? "preview: stopped" : current.error;
      writeLog({
        stream: current.error === "" ? "system" : "stderr",
        text: reason,
      });
      running._setRunning(false);
      running._writePrompt();
    }
  };

  const stops = [
    preview.subscribe(syncJob),
    preview.onLog((line) => {
      if (job !== null) {
        writeLog(line);
      }
    }),
  ];

  /** Route the shell's foreground through the preview while it runs: Ctrl+C
   * aborts the preview's job, and keystrokes go to no process. Everything else
   * stays the pod's own wiring. A typed command is tracked so the preview only
   * takes the foreground at a prompt. */
  const wrapWiring = (created: NodepodTerminal): void => {
    // SAFETY: `createTerminal` keeps the wiring it installed in this private
    // field; it is the SDK's `TerminalWiring`, of which `ShellWiring` is the
    // part this backend wraps — the rest is spread through unchanged.
    // oxlint-disable-next-line anti-slop/no-reflect-get -- the SDK declares the field private and exports no accessor; this is the one read of it
    const wired = Reflect.get(created, "_wiring") as ShellWiring;
    created._wireExecution({
      ...wired,
      getActiveAbort: () => job ?? wired.getActiveAbort(),
      getIsStdinRaw: () => job === null && wired.getIsStdinRaw(),
      getSendStdin: () => (job === null ? wired.getSendStdin() : null),
      onCommand: async (cmd) => {
        busy = true;
        try {
          await wired.onCommand(cmd);
        } finally {
          busy = false;
          syncJob();
        }
      },
    });
  };

  /** The shell's `preview` command. Custom commands are synchronous
   * `(cwd, args) => string`: the stop/restart they ask for runs async and the
   * message says what started, while the Preview panel shows what happened. */
  const previewCommand = (_cwd: string, args: string[]): string => {
    const [verb] = args;
    if (verb === "stop") {
      void preview.stop();
      return "preview: stopping.";
    }
    if (verb === "restart") {
      void preview.restart();
      return "preview: restarting.";
    }
    const current = preview.view();
    const lines = [
      `preview: ${current.state}${current.url === "" ? "" : ` ${current.url}`}`,
      ...current.processes,
    ];
    if (current.processes.length === 0) {
      lines.push("(no processes running)");
    }
    if (verb !== undefined) {
      lines.push(`unknown subcommand "${verb}" — try "preview stop".`);
    }
    return lines.join("\n");
  };

  return {
    close: () => {
      for (const stop of stops.splice(0)) {
        stop();
      }
      // `detach` disposes the tap it created (and the addons it loaded).
      shell?.detach();
      shell = null;
      tap = null;
      job = null;
      busy = false;
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
        customCommands: { preview: previewCommand },
      });
      next.setCwd(PROJECT_ROOT);
      wrapWiring(next);
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
      syncJob();
    },
    resize: (cols, rows) => {
      tap?.resize(cols, rows);
    },
  };
};
