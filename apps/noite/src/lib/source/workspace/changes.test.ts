import { describe, expect, test } from "bun:test";

import { Nodepod } from "@r1ck404/nodepod/headless";
import type { NodepodFS } from "@r1ck404/nodepod/headless";

import { deriveChanges, fileSha, listCheckout, listFiles } from "./changes";
import {
  objectPath,
  readJournal,
  writeBase,
  writeObject,
  writeJournal,
} from "./checkout";
import { discardAll, discardChange, restoreMove } from "./discard";
import { gitBlobSha } from "./git";
import { markPushed, pushPayload } from "./push";
import { parentDir, projectPath } from "./types";
import type {
  BaseEntry,
  BaseIndex,
  WorkspaceChange,
  WorkspaceFs,
  WorkspaceState,
} from "./types";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** A booted pod's filesystem, torn down however the test ends. */
const withPod = async (
  run: (fs: NodepodFS) => Promise<void>
): Promise<void> => {
  const pod = await Nodepod.boot();

  try {
    await run(pod.fs);
  } finally {
    await pod.teardown();
  }
};

/** Write one file into the checkout, making the directories it needs. */
const put = async (
  fs: NodepodFS,
  path: string,
  text: string
): Promise<void> => {
  const abs = projectPath(path);
  await fs.mkdir(parentDir(abs), { recursive: true });
  await fs.writeFile(abs, ENCODER.encode(text));
};

/** A pod holding a checkout already: the files on disk, the base index the
 * commit implies, and the committed bytes in the object cache — the state a
 * `checkout` leaves behind, without building an archive for every test. */
const seed = async (
  fs: NodepodFS,
  files: Record<string, string>
): Promise<WorkspaceState> => {
  const entries = await Promise.all(
    Object.entries(files).map(
      async ([path, text]): Promise<[string, BaseEntry]> => {
        const bytes = ENCODER.encode(text);
        await put(fs, path, text);
        const sha = await gitBlobSha(bytes);
        await writeObject(fs, sha, bytes);

        return [path, { mode: "100644", sha }];
      }
    )
  );

  const base: BaseIndex = {
    baseSha: "base1",
    entries: Object.fromEntries(entries),
  };

  await writeBase(fs, base);

  return { base, cache: new Map(), fs, journal: {} };
};

/** `fs` with every read counted, so a test can prove the hash cache spared
 * one. */
const countingFs = (fs: NodepodFS) => {
  let reads = 0;

  // SAFETY: this returns exactly what `fs.readFile` returns; the assertion
  // only puts back the two overloads, which one arrow cannot carry.
  const readFile = ((path: string, encoding?: "utf-8") => {
    reads += 1;

    return encoding === undefined
      ? fs.readFile(path)
      : fs.readFile(path, encoding);
  }) as WorkspaceFs["readFile"];

  const counted: WorkspaceFs = {
    exists: (path: string) => fs.exists(path),
    mkdir: (path: string, opts?: { recursive?: boolean }) =>
      fs.mkdir(path, opts),
    readFile,
    readdir: (path: string) => fs.readdir(path),
    rename: (from: string, to: string) => fs.rename(from, to),
    rm: (path: string, opts?: { force?: boolean; recursive?: boolean }) =>
      fs.rm(path, opts),
    stat: (path: string) => fs.stat(path),
    watch: (
      path: string,
      opts: { recursive?: boolean },
      notify: (event: string, filename: string | null) => void
    ) => fs.watch(path, opts, notify),
    writeFile: (path: string, data: string | Uint8Array) =>
      fs.writeFile(path, data),
  };

  return { counted, reads: () => reads };
};

/** The one row for `path`. A test that asks for a row the derive did not
 * produce has already gone wrong, so this says so instead of returning
 * `undefined` into the next assertion. */
const row = (
  changes: readonly WorkspaceChange[],
  path: string
): WorkspaceChange => {
  const found = changes.find((change) => change.path === path);

  if (found === undefined) {
    throw new Error(`no change for ${path}`);
  }

  return found;
};

/** What the derive reports, as the paths the panel lists them by. */
const derivedPaths = async (state: WorkspaceState): Promise<string[]> => {
  const changes = await deriveChanges(state);

  return changes.map((change) => change.path);
};

const TREE = {
  "README.md": "# hi\n",
  "src/main.ts": "export {};\n",
  "src/old.ts": "old\n",
};

describe("deriving the changes", () => {
  test("a checkout nobody touched has no changes", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      expect(await deriveChanges(state)).toEqual([]);
    });
  });

  test("every kind of change in one tree, in the panel's order", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "src/main.ts", "export const x = 1;\n");
      await put(fs, "src/new.ts", "new\n");
      await fs.rm(projectPath("README.md"), { force: true });
      await fs.rename(projectPath("src/old.ts"), projectPath("src/moved.ts"));
      await writeJournal(fs, { "src/moved.ts": "src/old.ts" });
      state.journal = await readJournal(fs);

      const changes = await deriveChanges(state);
      expect(changes.map((change) => change.path)).toEqual([
        "src/moved.ts",
        "src/main.ts",
        "src/new.ts",
        "README.md",
      ]);
      expect(row(changes, "src/moved.ts")).toEqual({
        after: "old\n",
        before: "old\n",
        kind: "moved",
        loading: false,
        movedFrom: "src/old.ts",
        path: "src/moved.ts",
      });
      expect(row(changes, "src/main.ts")).toEqual({
        after: "export const x = 1;\n",
        before: "export {};\n",
        kind: "modified",
        loading: false,
        path: "src/main.ts",
      });
      expect(row(changes, "src/new.ts")).toEqual({
        after: "new\n",
        before: "",
        kind: "added",
        loading: false,
        path: "src/new.ts",
      });
      expect(row(changes, "README.md")).toEqual({
        after: "",
        before: "# hi\n",
        kind: "deleted",
        loading: false,
        path: "README.md",
      });
    });
  });

  test("a move nobody journalled is paired by its blob id", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      const changes = await deriveChanges(state);
      expect(changes.map((change) => change.kind)).toEqual(["moved"]);
      expect(changes[0]?.path).toBe("src/renamed.ts");
      expect(changes[0]?.movedFrom).toBe("src/old.ts");
      expect(changes[0]?.before).toBe("old\n");
    });
  });

  test("a move whose bytes changed is still one moved row", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      await put(fs, "src/renamed.ts", "edited after the move\n");
      await writeJournal(fs, { "src/renamed.ts": "src/old.ts" });
      state.journal = await readJournal(fs);
      const changes = await deriveChanges(state);
      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("moved");
      expect(changes[0]?.after).toBe("edited after the move\n");
      expect(changes[0]?.before).toBe("old\n");
      expect(changes[0]?.movedFrom).toBe("src/old.ts");
    });
  });

  test("a copy left where the move came from is an addition, not a move", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "src/copy.ts", "old\n");
      await writeJournal(fs, { "src/copy.ts": "src/old.ts" });
      state.journal = await readJournal(fs);
      const changes = await deriveChanges(state);
      expect(changes).toEqual([
        {
          after: "old\n",
          before: "",
          kind: "added",
          loading: false,
          path: "src/copy.ts",
        },
      ]);
    });
  });

  test("bytes that are not text carry their count and no text", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.writeFile(
        projectPath("src/main.ts"),
        new Uint8Array([0, 1, 2, 255])
      );
      const changes = await deriveChanges(state);
      expect(changes[0]).toEqual({
        after: "",
        before: "export {};\n",
        binary: 4,
        kind: "modified",
        loading: false,
        path: "src/main.ts",
      });
    });
  });

  test("an empty directory is not a change", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.mkdir(projectPath("src/empty/deeper"), { recursive: true });
      expect(await deriveChanges(state)).toEqual([]);
    });
  });

  test("a file whose size and mtime stand still is not read again", async () => {
    await withPod(async (fs) => {
      const { counted, reads } = countingFs(fs);
      const state = await seed(fs, TREE);
      state.fs = counted;
      await deriveChanges(state);
      const afterFirst = reads();
      expect(afterFirst).toBeGreaterThan(0);
      expect(await deriveChanges(state)).toEqual([]);
      expect(reads()).toBe(afterFirst);
      // A write of a different length changes the key, so the file is read
      // again and the row reflects the new bytes.
      await put(fs, "README.md", "# a longer line\n");
      const changes = await deriveChanges(state);
      expect(changes).toHaveLength(1);
      expect(changes[0]?.after).toBe("# a longer line\n");
      expect(reads()).toBeGreaterThan(afterFirst);
    });
  });

  test("a blob the pod never cached shows as loading, not as empty text", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "README.md", "# changed\n");
      const sha = state.base.entries["README.md"]?.sha ?? "";
      await fs.rm(objectPath(sha), { force: true });
      const changes = await deriveChanges(state);
      expect(changes[0]?.loading).toBe(true);
      expect(changes[0]?.before).toBe("");
    });
  });

  test("the walk reports files, deepest names last, and their stats", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      const files = await listFiles(fs, state.base);
      expect(files.map((file) => file.path)).toEqual([
        "README.md",
        "src/main.ts",
        "src/old.ts",
      ]);
      expect(files[0]?.size).toBe(5);
      expect(files[0]?.mtime).toBeGreaterThan(0);
      const digest = await fileSha(fs, new Map(), files[0]);
      expect(digest.sha).toBe(await gitBlobSha(ENCODER.encode("# hi\n")));
      expect(DECODER.decode(digest.bytes ?? new Uint8Array())).toBe("# hi\n");
    });
  });
});

describe("the push payload", () => {
  test("text writes, base64 uploads, renames and removals", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "src/main.ts", "export const x = 1;\n");
      await fs.writeFile(
        projectPath("logo.png"),
        new Uint8Array([0, 1, 2, 255])
      );
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      await writeJournal(fs, { "src/renamed.ts": "src/old.ts" });
      state.journal = await readJournal(fs);
      await fs.rm(projectPath("README.md"), { force: true });

      const payload = await pushPayload(state);
      expect(payload.moves).toEqual([
        { from: "src/old.ts", to: "src/renamed.ts" },
      ]);
      expect(payload.deletes).toEqual(["README.md"]);
      expect(payload.files).toEqual([
        { content: "old\n", path: "src/renamed.ts" },
        { content: "export const x = 1;\n", path: "src/main.ts" },
        {
          content: "AAEC/w==",
          encoding: "base64",
          path: "logo.png",
        },
      ]);
    });
  });

  test("a move no journal knows travels as a write plus a removal", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      const payload = await pushPayload(state);
      expect(payload.moves).toEqual([]);
      expect(payload.deletes).toEqual(["src/old.ts"]);
      expect(payload.files).toEqual([
        { content: "old\n", path: "src/renamed.ts" },
      ]);
    });
  });

  test("nothing to push is an empty payload, never a missing field", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      expect(await pushPayload(state)).toEqual({
        deletes: [],
        files: [],
        moves: [],
      });
    });
  });
});

describe("re-basing on the commit that was made", () => {
  test("markPushed writes the new base, caches the new blobs and clears the journal", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "src/main.ts", "export const x = 1;\n");
      await put(fs, "src/new.ts", "new\n");
      await fs.rm(projectPath("README.md"), { force: true });
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      await writeJournal(fs, { "src/renamed.ts": "src/old.ts" });
      state.journal = await readJournal(fs);

      await markPushed(state, "commit2");

      expect(state.base.baseSha).toBe("commit2");
      expect(state.journal).toEqual({});
      expect(await readJournal(fs)).toEqual({});
      expect(Object.keys(state.base.entries).toSorted()).toEqual([
        "src/main.ts",
        "src/new.ts",
        "src/renamed.ts",
      ]);
      // The mode of a path the commit already knew is kept; a new path is a
      // plain file.
      expect(state.base.entries["src/main.ts"]?.mode).toBe("100644");
      // The committed bytes are in the object cache now, so a later diff of the
      // new base needs no network.
      const kept = state.base.entries["src/new.ts"]?.sha ?? "";
      expect(await fs.readFile(objectPath(kept), "utf-8")).toBe("new\n");
      expect(await deriveChanges(state)).toEqual([]);
    });
  });
});

describe("discarding", () => {
  test("an edit goes back to the committed bytes, an addition leaves the tree", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "src/main.ts", "edited\n");
      await put(fs, "src/new.ts", "new\n");
      const changes = await deriveChanges(state);
      await discardChange(state, row(changes, "src/main.ts"));
      await discardChange(state, row(changes, "src/new.ts"));
      expect(await fs.readFile(projectPath("src/main.ts"), "utf-8")).toBe(
        "export {};\n"
      );
      expect(await fs.exists(projectPath("src/new.ts"))).toBe(false);
      expect(await deriveChanges(state)).toEqual([]);
    });
  });

  test("a staged removal comes back", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.rm(projectPath("README.md"), { force: true });
      const changes = await deriveChanges(state);
      await discardChange(state, changes[0]);
      expect(await fs.readFile(projectPath("README.md"), "utf-8")).toBe(
        "# hi\n"
      );
      expect(await deriveChanges(state)).toEqual([]);
    });
  });

  test("discarding a moved and edited file keeps its move and drops its edit", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      await put(fs, "src/renamed.ts", "edited after the move\n");
      await writeJournal(fs, { "src/renamed.ts": "src/old.ts" });
      state.journal = await readJournal(fs);
      const changes = await deriveChanges(state);
      await discardChange(state, changes[0]);
      expect(await fs.readFile(projectPath("src/renamed.ts"), "utf-8")).toBe(
        "old\n"
      );
      expect(state.journal).toEqual({ "src/renamed.ts": "src/old.ts" });
      const after = await deriveChanges(state);
      expect(after.map((change) => change.kind)).toEqual(["moved"]);
      expect(after[0]?.after).toBe(after[0]?.before);
    });
  });

  test("restore walks a move home and forgets it", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      await put(fs, "src/renamed.ts", "edited\n");
      await writeJournal(fs, { "src/renamed.ts": "src/old.ts" });
      state.journal = await readJournal(fs);
      const changes = await deriveChanges(state);
      await restoreMove(state, changes[0]);
      expect(await fs.exists(projectPath("src/renamed.ts"))).toBe(false);
      expect(await fs.readFile(projectPath("src/old.ts"), "utf-8")).toBe(
        "old\n"
      );
      expect(await readJournal(fs)).toEqual({});
      expect(await deriveChanges(state)).toEqual([]);
    });
  });

  test("discarding everything leaves the checkout as the commit has it", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "src/main.ts", "edited\n");
      await put(fs, "src/new.ts", "new\n");
      await fs.rm(projectPath("README.md"), { force: true });
      await fs.rename(projectPath("src/old.ts"), projectPath("src/renamed.ts"));
      await put(fs, "src/renamed.ts", "edited after the move\n");
      await writeJournal(fs, { "src/renamed.ts": "src/old.ts" });
      state.journal = await readJournal(fs);

      const changes = await deriveChanges(state);
      expect(changes).toHaveLength(4);
      await discardAll(state, changes);

      expect(await deriveChanges(state)).toEqual([]);
      expect(await readJournal(fs)).toEqual({});
      expect(await fs.readFile(projectPath("src/old.ts"), "utf-8")).toBe(
        "old\n"
      );
      expect(await fs.exists(projectPath("src/renamed.ts"))).toBe(false);
      expect(await fs.exists(projectPath("src/new.ts"))).toBe(false);
      expect(await fs.readFile(projectPath("README.md"), "utf-8")).toBe(
        "# hi\n"
      );
    });
  });

  test("a committed copy the pod does not hold is an error, not a silent erase", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, TREE);
      await put(fs, "src/main.ts", "edited\n");
      const sha = state.base.entries["src/main.ts"]?.sha ?? "";
      await fs.rm(objectPath(sha), { force: true });
      const changes = await deriveChanges(state);
      await expect(discardChange(state, changes[0])).rejects.toThrow(
        "no committed copy of src/main.ts"
      );
    });
  });
});

describe("the checkout's .gitignore", () => {
  test("an excluded path is a row in the tree but never a change", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, { ".gitignore": "dist/\n", "a.txt": "a\n" });
      await put(fs, "dist/a.js", "built\n");
      expect(await deriveChanges(state)).toEqual([]);
      expect(await listCheckout(fs, state.base)).toEqual({
        dirs: [],
        files: [".gitignore", "a.txt"],
        ignoredDirs: ["dist"],
        ignoredFiles: [],
      });
    });
  });

  test("the dependency folder is always excluded, and never walked", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, { "a.txt": "a\n" });
      await put(fs, "node_modules/pkg/index.js", "installed\n");
      expect(await deriveChanges(state)).toEqual([]);
      const listing = await listCheckout(fs, state.base);
      expect(listing.files).toEqual(["a.txt"]);
      expect(listing.ignoredDirs).toEqual(["node_modules"]);
      // Not one row under it: git does not look inside an excluded folder
      // either, and an install's tree is unbounded.
      expect(listing.ignoredFiles).toEqual([]);
    });
  });

  test("a committed path is a change even where the rules would exclude it", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, {
        ".gitignore": "dist/\n",
        "dist/a.js": "one\n",
      });

      await put(fs, "dist/a.js", "two\n");
      await put(fs, "dist/new.js", "new\n");
      // Git keeps tracking what it has committed: a.js is a change, and the
      // folder above it is no more dimmed than git dims it. What the same
      // folder gained since is excluded, exactly as `git status` leaves it.
      expect(await derivedPaths(state)).toEqual(["dist/a.js"]);
      const listing = await listCheckout(fs, state.base);
      expect(listing.files).toEqual([".gitignore", "dist/a.js"]);
      expect(listing.ignoredDirs).toEqual([]);
      expect(listing.ignoredFiles).toEqual(["dist/new.js"]);
    });
  });

  test("a nested .gitignore rules over its own directory only", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, {
        "src/.gitignore": "*.map\n",
        "src/a.ts": "a\n",
      });

      await put(fs, "src/a.ts.map", "map\n");
      await put(fs, "a.ts.map", "map\n");
      expect(await derivedPaths(state)).toEqual(["a.ts.map"]);
      const listing = await listCheckout(fs, state.base);
      expect(listing.ignoredFiles).toEqual(["src/a.ts.map"]);
    });
  });

  test("a ! rule keeps its path a change", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, { ".gitignore": "*.log\n!keep.log\n" });
      await put(fs, "x.log", "x\n");
      await put(fs, "keep.log", "keep\n");
      expect(await derivedPaths(state)).toEqual(["keep.log"]);
      const listing = await listCheckout(fs, state.base);
      expect(listing.ignoredFiles).toEqual(["x.log"]);
    });
  });

  test("rules reach the derive as soon as the file holding them lands", async () => {
    await withPod(async (fs) => {
      const state = await seed(fs, { ".gitignore": "", "a.txt": "a\n" });
      await put(fs, "dist/a.js", "built\n");
      expect(await derivedPaths(state)).toEqual(["dist/a.js"]);
      // The write itself is an ordinary change; what it announces is not.
      await put(fs, ".gitignore", "dist/\n");
      expect(await derivedPaths(state)).toEqual([".gitignore"]);
      const ruled = await listCheckout(fs, state.base);
      expect(ruled.ignoredDirs).toEqual(["dist"]);
      // Taking the rule back out gives the path back with it.
      await put(fs, ".gitignore", "");
      expect(await derivedPaths(state)).toEqual(["dist/a.js"]);
      const listing = await listCheckout(fs, state.base);
      expect(listing.ignoredDirs).toEqual([]);
    });
  });
});
