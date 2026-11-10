import { describe, expect, test } from "bun:test";

import {
  deleting,
  nextWrite,
  R2WriteState,
  writeProblem,
  writeRunning,
} from "./write";

describe("R2 write lifecycle", () => {
  test("a full success returns to Idle", () => {
    const running = nextWrite(R2WriteState.Idle(), {
      count: 2,
      kind: "start",
      scope: "upload",
    });

    expect(writeRunning(running)).toBe(true);
    expect(deleting(running)).toBe(false);

    const settled = nextWrite(running, { kind: "settled", problems: [] });
    expect(settled._tag).toBe("Idle");
    expect(writeProblem(settled)).toBeNull();
  });

  test("a partial upload is a state, not an error string", () => {
    // P2 fail-before: oversize files were pushed into the same `failure`
    // atom as a network error, so a successful upload showed an error.
    const running = nextWrite(R2WriteState.Idle(), {
      count: 3,
      kind: "start",
      scope: "upload",
    });

    const partial = nextWrite(running, {
      kind: "settled",
      problems: ["2 file(s) exceed the cap."],
    });

    expect(partial._tag).toBe("Partial");
    expect(writeProblem(partial)).toBe("2 file(s) exceed the cap.");
    expect(writeRunning(partial)).toBe(false);
  });

  test("only a delete disables the delete control", () => {
    const uploading = nextWrite(R2WriteState.Idle(), {
      count: 1,
      kind: "start",
      scope: "upload",
    });

    expect(deleting(uploading)).toBe(false);

    const removing = nextWrite(R2WriteState.Idle(), {
      count: 1,
      kind: "start",
      scope: "delete",
    });

    expect(deleting(removing)).toBe(true);
  });

  test("a second start is refused while one write runs", () => {
    const running = nextWrite(R2WriteState.Idle(), {
      count: 1,
      kind: "start",
      scope: "mkdir",
    });

    expect(
      nextWrite(running, { count: 1, kind: "start", scope: "upload" })
    ).toEqual(running);
  });

  test("a network failure keeps the scope and can be dismissed", () => {
    const running = nextWrite(R2WriteState.Idle(), {
      count: 1,
      kind: "start",
      scope: "delete",
    });

    const failed = nextWrite(running, {
      kind: "failed",
      message: "the store refused the write (500)",
    });

    expect(writeProblem(failed)).toBe("the store refused the write (500)");
    expect(nextWrite(failed, { kind: "dismiss" })._tag).toBe("Idle");
  });
});
