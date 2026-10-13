/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- this file is a test double: a scripted preview session standing in for the frame's own runtime */
import { beforeAll, describe, expect, test } from "bun:test";

import { Nodepod } from "@r1ck404/nodepod/headless";

import type { PodPreviewLog, PodPreviewView } from "../lib/source/pod-protocol";
import { installDomFixture } from "../testing/dom";
import type { PodPreviewRuntime } from "./preview-runtime";
import { createTerminalBackend } from "./terminal-backend";
import type { TerminalBackend } from "./terminal-backend";

/** The origin a preview URL would have to be on: the runtime is handed it
 * rather than reading `location`, which a bun test does not have. */
const PREVIEW_URL = "https://app-0.preview.demo.example/__virtual__/pod/5173/";

beforeAll(() => {
  installDomFixture();
});

/** A preview the test drives, standing in for `preview-runtime.ts` (whose own
 * test covers it): a state, a log, and a `stop` that gives the prompt back the
 * way the real session does. */
const scriptedPreview = (): {
  log: (line: PodPreviewLog) => void;
  preview: PodPreviewRuntime;
  start: () => void;
  stops: () => number;
} => {
  const listeners = new Set<() => void>();
  const logListeners = new Set<(line: PodPreviewLog) => void>();
  let state: PodPreviewView["state"] = "idle";
  let logs: PodPreviewLog[] = [];
  let stops = 0;
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const view = (): PodPreviewView => ({
    detail: "",
    error: "",
    logs: [...logs],
    plan: null,
    processes: [],
    state,
    url: state === "ready" ? PREVIEW_URL : "",
  });
  const preview: PodPreviewRuntime = {
    attach: () => {
      // Nothing to attach: the shell only reads the view.
    },
    close: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    onLog: (listener) => {
      logListeners.add(listener);
      return () => {
        logListeners.delete(listener);
      };
    },
    open: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    stop: () => {
      stops += 1;
      state = "idle";
      notify();
      return Promise.resolve();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view,
  };
  return {
    log: (line) => {
      logs = [...logs, line];
      for (const listener of logListeners) {
        listener(line);
      }
      notify();
    },
    preview,
    start: () => {
      state = "ready";
      notify();
    },
    stops: () => stops,
  };
};

/** One shell on a fresh pod, with everything it wrote so far. */
const withShell = async (
  run: (shell: {
    backend: TerminalBackend;
    preview: ReturnType<typeof scriptedPreview>;
    written: string[];
  }) => Promise<void> | void
): Promise<void> => {
  const pod = await Nodepod.boot();
  const written: string[] = [];
  const preview = scriptedPreview();
  const backend = createTerminalBackend({
    onWrite: (data) => {
      written.push(data);
    },
    pod,
    preview: preview.preview,
  });
  try {
    await run({ backend, preview, written });
  } finally {
    backend.close();
    await pod.teardown();
  }
};

describe("the frame's shell", () => {
  test("draws its prompt on open, at the page's size", async () => {
    await withShell(({ backend, written }) => {
      expect(written).toEqual([]);
      backend.open(100, 30);
      // The prompt goes out as a `terminal.write` the page can draw: this tap
      // renders nothing itself.
      expect(written).toHaveLength(1);
      expect(written[0]).toEndWith("$ ");
    });
  });

  test("echoes what the user types and takes it back on backspace", async () => {
    await withShell(({ backend, written }) => {
      backend.open(100, 30);
      written.length = 0;
      backend.input("n");
      backend.input("p");
      expect(written.join("")).toBe("np");
      // The SDK's own line editing rewrites the deleted character the way a
      // renderer's would: back up, blank it, back up.
      backend.input("\u007F");
      expect(written.join("")).toBe("np\b \b");
    });
  });

  test("prints ^C and a fresh prompt when Ctrl+C interrupts the line", async () => {
    await withShell(({ backend, preview, written }) => {
      backend.open(100, 30);
      written.length = 0;
      backend.input("half-typed");
      backend.input("\u0003");
      const output = written.join("");
      expect(output).toStartWith("half-typed");
      expect(output).toContain("^C");
      expect(output).toEndWith("$ ");
      // The shell had the prompt, not the preview: nothing was stopped.
      expect(preview.stops()).toBe(0);
    });
  });

  test("runs the preview as the foreground job, and Ctrl+C stops it", async () => {
    await withShell(({ backend, preview, written }) => {
      backend.open(100, 30);
      written.length = 0;
      preview.log({ stream: "stdout", text: "ready in 120ms" });
      preview.start();
      // The preview's own line, then everything it printed so far.
      expect(written.join("")).toBe("preview\r\nready in 120ms\r\n");
      written.length = 0;
      preview.log({ stream: "stdout", text: "GET / 200" });
      expect(written.join("")).toBe("GET / 200\r\n");
      // Typing goes to no process while the preview holds the foreground.
      backend.input("x");
      expect(written.join("")).toBe("GET / 200\r\n");
      backend.input("\u0003");
      expect(written.join("")).toContain("^C");
      expect(preview.stops()).toBe(1);
      // Stopping gives the prompt back, and typing echoes again.
      written.length = 0;
      backend.input("y");
      expect(written.join("")).toBe("y");
    });
  });

  test("keeps a resize and stops writing once the panel closes", async () => {
    await withShell(({ backend, written }) => {
      backend.open(100, 30);
      backend.resize(140, 40);
      written.length = 0;
      backend.close();
      backend.input("after close");
      backend.resize(80, 24);
      expect(written).toEqual([]);
    });
  });
});
