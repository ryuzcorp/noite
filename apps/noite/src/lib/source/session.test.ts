import { describe, expect, test } from "bun:test";

import type { RunnerTree } from "../runner";
import {
  add,
  addUpload,
  changeCount,
  changes,
  commitInput,
  discard,
  discardAll,
  edit,
  emptySession,
  move,
  openSession,
  prime,
  remove,
} from "./session";
import type { EditSession, SessionResult } from "./session";

const TREE: RunnerTree = {
  files: [
    { mode: "100644", path: "README.md", sha: "a".repeat(40), size: 10 },
    { mode: "100644", path: "src/app.ts", sha: "b".repeat(40), size: 20 },
    { mode: "100644", path: "src/lib.ts", sha: "c".repeat(40), size: 30 },
  ],
  sha: "f".repeat(40),
  truncated: false,
};

const opened = (): EditSession => openSession(TREE);

const ok = (result: SessionResult): EditSession => {
  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`);
  }

  return result.session;
};

describe("the edit session's path states", () => {
  test("a fresh session holds no changes", () => {
    expect(changes(opened())).toEqual([]);
    expect(changeCount(opened())).toBe(0);
    expect(commitInput(opened())).toEqual({
      deletes: [],
      files: [],
      moves: [],
    });
  });

  test("an edit that lands back on the committed text is not a change", () => {
    const primed = prime(opened(), "README.md", "hello");
    const typed = edit(primed, "README.md", "hello!", "hello");
    expect(changes(typed).map((row) => row.kind)).toEqual(["modified"]);

    const reverted = edit(typed, "README.md", "hello", "hello");
    expect(changes(reverted)).toEqual([]);
    expect(commitInput(reverted).files).toEqual([]);
  });

  test("editing a committed file without its base text is refused", () => {
    const session = opened();
    expect(edit(session, "README.md", "hello", null)).toBe(session);
  });

  test("adding a committed path is refused", () => {
    const result = add(opened(), "README.md", "again");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("already exists");
  });

  test("a deletion carries the row, not the bytes", () => {
    const session = remove(opened(), "src/lib.ts");
    const [row] = changes(session);

    expect(row).toEqual({
      after: "",
      before: null,
      kind: "deleted",
      path: "src/lib.ts",
    });
    expect(new Set(session.deletes)).toEqual(new Set(["src/lib.ts"]));
  });

  test("deleting an added file forgets its buffer", () => {
    const session = ok(add(opened(), "notes.md", "draft"));
    const deleted = remove(session, "notes.md");

    expect(changes(deleted)).toEqual([]);
    expect(deleted.deletes.size).toBe(0);
  });

  test("an upload is an added file with its byte count", () => {
    const session = ok(
      addUpload(opened(), "logo.png", { bytes: 12, content: "aGVsbG8=" })
    );

    expect(changes(session)).toEqual([
      {
        after: "",
        before: "",
        bytes: 12,
        kind: "added",
        path: "logo.png",
      },
    ]);
    expect(commitInput(session).files).toEqual([
      { content: "aGVsbG8=", encoding: "base64", path: "logo.png" },
    ]);
  });
});

describe("moves", () => {
  test("a committed file moves without its bytes being written again", () => {
    const primed = prime(opened(), "README.md", "hello");
    const moved = move(primed, "README.md", "docs.md");

    expect(moved.ok).toBe(true);

    if (!moved.ok) {
      return;
    }

    // The buffer was primed with the committed text, so the row carries it on
    // both sides: a move with no byte change, which is what the row says.
    expect(changes(moved.session)).toEqual([
      {
        after: "hello",
        before: "hello",
        kind: "moved",
        movedFrom: "README.md",
        path: "docs.md",
      },
    ]);
    expect(commitInput(moved.session)).toEqual({
      deletes: [],
      files: [],
      moves: [{ from: "README.md", to: "docs.md" }],
    });
  });

  test("a moved file that was also edited writes both", () => {
    const primed = prime(opened(), "README.md", "hello");
    const typed = edit(primed, "README.md", "hello there", "hello");
    const moved = move(typed, "README.md", "docs.md");

    if (!moved.ok) {
      throw new Error(moved.reason);
    }

    expect(changes(moved.session)).toEqual([
      {
        after: "hello there",
        before: "hello",
        kind: "moved",
        movedFrom: "README.md",
        path: "docs.md",
      },
    ]);
    expect(commitInput(moved.session)).toEqual({
      deletes: [],
      files: [{ content: "hello there", path: "docs.md" }],
      moves: [{ from: "README.md", to: "docs.md" }],
    });
  });

  test("a move onto a held path is refused", () => {
    const result = move(opened(), "README.md", "src/lib.ts");

    expect(result.ok).toBe(false);
  });

  test("deleting a moved file deletes its origin", () => {
    const moved = move(opened(), "README.md", "docs.md");

    if (!moved.ok) {
      throw new Error(moved.reason);
    }

    const deleted = remove(moved.session, "docs.md");

    expect(deleted.moves.size).toBe(0);
    expect(new Set(deleted.deletes)).toEqual(new Set(["README.md"]));
  });

  test("moving an added file renames its buffer", () => {
    const added = ok(add(opened(), "notes.md", "draft"));
    const moved = move(added, "notes.md", "docs/notes.md");

    if (!moved.ok) {
      throw new Error(moved.reason);
    }

    expect(changes(moved.session)).toEqual([
      { after: "draft", before: "", kind: "added", path: "docs/notes.md" },
    ]);
    expect(moved.session.moves.size).toBe(0);
  });
});

describe("discarding", () => {
  test("discard drops one buffer and its deletion", () => {
    const typed = edit(opened(), "README.md", "changed", "hello");
    const deleted = remove(typed, "src/lib.ts");
    const dropped = discard(deleted, "README.md");

    expect(changes(dropped).map((row) => row.path)).toEqual(["src/lib.ts"]);
    expect(changes(discard(dropped, "src/lib.ts"))).toEqual([]);
  });

  test("discard all goes back to the commit", () => {
    const typed = edit(opened(), "README.md", "changed", "hello");
    const added = ok(add(typed, "notes.md", "draft"));
    const moved = move(added, "src/app.ts", "app.ts");

    if (!moved.ok) {
      throw new Error(moved.reason);
    }

    expect(changes(discardAll(moved.session))).toEqual([]);
  });
});

describe("commitInput", () => {
  test("one body carries every kind of change", () => {
    const typed = edit(opened(), "README.md", "changed", "hello");
    const added = ok(add(typed, "notes.md", "draft"));
    const moved = move(added, "src/app.ts", "app.ts");

    if (!moved.ok) {
      throw new Error(moved.reason);
    }

    const deleted = remove(moved.session, "src/lib.ts");

    expect(commitInput(deleted)).toEqual({
      deletes: ["src/lib.ts"],
      files: [
        { content: "changed", path: "README.md" },
        { content: "draft", path: "notes.md" },
      ],
      moves: [{ from: "src/app.ts", to: "app.ts" }],
    });
  });

  test("an empty session commits nothing", () => {
    expect(commitInput(emptySession())).toEqual({
      deletes: [],
      files: [],
      moves: [],
    });
  });
});
