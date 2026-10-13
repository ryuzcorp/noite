/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- this file is a test double: the element the tap is opened on is a bare object standing in for a DOM node */
import { describe, expect, test } from "bun:test";

import { StubFitAddon, StubTerminal, stubTerminalClass } from "./stub-terminal";

/** What one write was handed, and what the sink saw, in order. */
const tap = (): { sink: string[]; terminal: StubTerminal } => {
  const sink: string[] = [];
  return {
    sink,
    terminal: new StubTerminal({ theme: { background: "#000" } }, (text) => {
      sink.push(text);
    }),
  };
};

describe("the terminal tap", () => {
  test("keeps the options the SDK constructed it with", () => {
    const { terminal } = tap();
    expect(terminal.options.theme).toEqual({ background: "#000" });
    // The SDK writes a new theme straight into the bag; nothing else cares.
    terminal.options.theme = { background: "#fff" };
    expect(terminal.options.theme).toEqual({ background: "#fff" });
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  test("sends every write to the sink and keeps the transcript", () => {
    const { sink, terminal } = tap();
    terminal.write("a");
    terminal.writeln("b");
    terminal.clear();
    expect(sink).toEqual(["a", "b\r\n", "\u001B[2J\u001B[H"]);
    expect(terminal.output).toEqual(sink);
  });

  test("hands its keystrokes to whatever the SDK attached", () => {
    const { terminal } = tap();
    const typed: string[] = [];
    const attached = terminal.onData((data) => {
      typed.push(data);
    });
    terminal.feed("npm run dev\r");
    expect(typed).toEqual(["npm run dev\r"]);
    attached.dispose();
    terminal.feed("x");
    expect(typed).toEqual(["npm run dev\r"]);
  });

  test("tells the SDK the grid changed, once per listener", () => {
    const { terminal } = tap();
    let resizes = 0;
    const attached = terminal.onResize(() => {
      resizes += 1;
    });
    terminal.resize(120, 40);
    expect([terminal.cols, terminal.rows]).toEqual([120, 40]);
    expect(resizes).toBe(1);
    attached.dispose();
    terminal.resize(100, 30);
    expect(resizes).toBe(1);
  });

  test("opens on the element it is handed, and nothing after dispose", () => {
    const { sink, terminal } = tap();
    const host = { id: "shell" } as unknown as Element;
    terminal.open(host);
    expect(terminal.target).toBe(host);
    terminal.focus();
    expect(terminal.focused).toBe(true);
    let disposed = 0;
    terminal.loadAddon({
      dispose: () => {
        disposed += 1;
      },
    });
    terminal.dispose();
    expect(disposed).toBe(1);
    terminal.write("late");
    terminal.resize(90, 20);
    expect(sink).toEqual([]);
  });

  test("the class the SDK is handed writes to that session's sink", () => {
    const seen: string[] = [];
    const Terminal = stubTerminalClass((text) => {
      seen.push(text);
    });
    const instance = new Terminal({});
    instance.write("prompt$ ");
    expect(seen).toEqual(["prompt$ "]);
    expect(instance).toBeInstanceOf(StubTerminal);
  });

  test("the fit addon has nothing to measure", () => {
    expect(new StubFitAddon().fit()).toBeUndefined();
  });
});
