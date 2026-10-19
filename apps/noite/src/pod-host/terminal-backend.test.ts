/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- this file is a test double: the frame's shell driven through its own tap */
import { beforeAll, describe, expect, test } from "bun:test";

import { Nodepod } from "@r1ck404/nodepod/headless";

import { installDomFixture } from "../testing/dom";
import { createTerminalBackend } from "./terminal-backend";
import type { TerminalBackend } from "./terminal-backend";

beforeAll(() => {
  installDomFixture();
});

/** One shell on a fresh pod, with everything it wrote so far. */
const withShell = async (
  run: (shell: {
    backend: TerminalBackend;
    written: string[];
  }) => Promise<void> | void
): Promise<void> => {
  const pod = await Nodepod.boot();
  const written: string[] = [];

  const backend = createTerminalBackend({
    onWrite: (data) => {
      written.push(data);
    },
    pod,
  });

  try {
    await run({ backend, written });
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
    await withShell(({ backend, written }) => {
      backend.open(100, 30);
      written.length = 0;
      backend.input("half-typed");
      backend.input("\u0003");
      const output = written.join("");
      expect(output).toStartWith("half-typed");
      expect(output).toContain("^C");
      expect(output).toEndWith("$ ");
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
