import { describe, expect, test } from "bun:test";

import type { WorkspacePersistence } from "@r1ck404/nodepod";
import { Nodepod } from "@r1ck404/nodepod/headless";
import type { NodepodFS } from "@r1ck404/nodepod/headless";

import { readBase, readJournal, writeBase, writeObject } from "./checkout";
import { gitBlobSha } from "./git";
import { parentDir, projectPath } from "./types";
import type {
  BaseEntry,
  BaseIndex,
  OpenPod,
  OpenPodOpener,
  PodOptions,
  PushPayload,
  Workspace,
  WorkspaceChange,
  WorkspaceOptions,
} from "./types";
import { createWorkspace } from "./workspace";

const ENCODER = new TextEncoder();

/** The knobs a test turns when it opens a workspace. */
interface Opening {
  /** Whether the ref may be edited at all (a tag or a commit is not). */
  editable?: boolean;
  /** The commit the ref resolves to right now. */
  sha?: string;
}

/** The pod's persistence as the facade drives it: `pendingChanges` is what it
 * still owes IndexedDB (0 once `flush` has saved), and `log` records what the
 * pod saved and what the panel was told, in the order both happened. */
interface FakePersistence {
  log: string[];
  pendingChanges: number;
}

/** The pod a test owns, and the facade opened on top of it. */
interface TestPod {
  closed: () => boolean;
  fs: NodepodFS;
  persistence: FakePersistence;
  workspace: (opening?: Opening) => Promise<Workspace>;
}

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
 * commit implies, and the committed bytes in the object cache. */
const seed = async (
  fs: NodepodFS,
  files: Record<string, string>,
  baseSha = "tip"
): Promise<void> => {
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
    baseSha,
    entries: Object.fromEntries(entries),
  };
  await writeBase(fs, base);
};

/** Boot a pod, hand the test the facade's opener and its filesystem, and tear
 * the pod down however the test ends. */
const withPod = async (run: (pod: TestPod) => Promise<void>): Promise<void> => {
  const pod = await Nodepod.boot();
  const persistence: FakePersistence = { log: [], pendingChanges: 0 };
  let alive = true;
  let closed = false;
  const opener: OpenPodOpener = (options: PodOptions): Promise<OpenPod> =>
    Promise.resolve({
      close: async () => {
        alive = false;
        closed = true;
        await pod.teardown();
      },
      editable: options.editable,
      flush: () => {
        persistence.pendingChanges = 0;
        persistence.log.push("saved");
        return Promise.resolve();
      },
      fs: pod.fs,
      onPeerChange: () => () => {},
      // SAFETY: the facade reads `pendingChanges` off the pod's persistence
      // and saves through `flush`; those two are the whole fake.
      persistence: {
        get pendingChanges(): number {
          return persistence.pendingChanges;
        },
      } as WorkspacePersistence,
      pod,
    });
  const options = (opening: Opening): WorkspaceOptions => ({
    appId: "app1",
    branch: "main",
    editable: opening.editable ?? true,
    // The checkout itself is covered in checkout.test.ts; here it only has to
    // be an archive the pod can lay down (the tests seed the pod instead).
    fetchArchive: () => Promise.resolve(new Uint8Array(1024)),
    files: [],
    onSaveError: (error) => {
      // The fake pod's saves never fail; a real one reports through here.
      throw error instanceof Error ? error : new Error(String(error));
    },
    openPod: opener,
    sha: opening.sha ?? "tip",
  });
  try {
    await run({
      closed: () => closed,
      fs: pod.fs,
      persistence,
      workspace: (opening = {}) => createWorkspace(options(opening)),
    });
  } finally {
    if (alive) {
      await pod.teardown();
    }
  }
};

/** The next rows the workspace publishes. */
const nextChange = (ws: Workspace): Promise<WorkspaceChange[]> => {
  const { promise, resolve } = Promise.withResolvers<WorkspaceChange[]>();
  const off = ws.onChanges((changes) => {
    off();
    resolve(changes);
  });
  return promise;
};

describe("opening a workspace", () => {
  test("restores the saved checkout and reports what it holds", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" });
      await put(pod.fs, "README.md", "# changed\n");
      const ws = await pod.workspace();
      expect(ws.baseSha).toBe("tip");
      expect(ws.stale).toBeNull();
      expect(ws.editable).toBe(true);
      expect(ws.changes()).toEqual([
        {
          after: "# changed\n",
          before: "# hi\n",
          kind: "modified",
          loading: false,
          path: "README.md",
        },
      ]);
    });
  });

  test("checks the ref out when the pod holds nothing", async () => {
    await withPod(async (pod) => {
      const ws = await pod.workspace();
      expect(ws.baseSha).toBe("tip");
      const base = await readBase(pod.fs);
      expect(base?.baseSha).toBe("tip");
    });
  });

  test("keeps unpushed work when the ref moved, and says the checkout is stale", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" }, "base1");
      await put(pod.fs, "README.md", "# changed\n");
      const ws = await pod.workspace({ sha: "tip2" });
      expect(ws.stale).toBe("tip2");
      expect(ws.baseSha).toBe("base1");
      expect(ws.changes()).toHaveLength(1);
      expect(await pod.fs.readFile(projectPath("README.md"), "utf-8")).toBe(
        "# changed\n"
      );
    });
  });

  test("replaces a clean checkout when the ref moved", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" }, "base1");
      const ws = await pod.workspace({ sha: "tip2" });
      expect(ws.baseSha).toBe("tip2");
      expect(ws.stale).toBeNull();
      expect(await pod.fs.exists(projectPath("README.md"))).toBe(false);
      expect(ws.changes()).toEqual([]);
    });
  });

  test("a read-only ref refuses every write", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "a.txt": "one\n" });
      const ws = await pod.workspace({ editable: false });
      expect(ws.editable).toBe(false);
      await expect(ws.writeText("a.txt", "x")).rejects.toThrow("read-only");
      await expect(ws.remove("a.txt")).rejects.toThrow("read-only");
      await expect(ws.discardAll()).rejects.toThrow("read-only");
    });
  });
});

describe("the workspace's own filesystem is the trigger", () => {
  test("a write reaches the panel through the pod's watcher", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" });
      const ws = await pod.workspace();
      const next = nextChange(ws);
      await ws.writeText("src/new.ts", "new\n");
      expect(await next).toEqual([
        {
          after: "new\n",
          before: "",
          kind: "added",
          loading: false,
          path: "src/new.ts",
        },
      ]);
    });
  });

  test("a rewrite of the same length and millisecond is still seen", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" });
      const ws = await pod.workspace();
      const next = nextChange(ws);
      await ws.writeText("README.md", "# ho\n");
      // The size and the mtime are unchanged, so only the event dropping the
      // hash for that path can find it.
      expect(await next).toEqual([
        {
          after: "# ho\n",
          before: "# hi\n",
          kind: "modified",
          loading: false,
          path: "README.md",
        },
      ]);
    });
  });

  test("a refresh answers for a change made behind the facade, until it is dropped", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" });
      const ws = await pod.workspace();
      const seen: WorkspaceChange[][] = [];
      const off = ws.onChanges((changes) => seen.push(changes));
      await put(pod.fs, "scripted.txt", "written by a script\n");
      await ws.refresh();
      expect(ws.changes().map((change) => change.path)).toEqual([
        "scripted.txt",
      ]);
      const told = seen.length;
      off();
      await ws.refresh();
      expect(seen).toHaveLength(told);
    });
  });

  test("a rename journals the move and shows one moved row", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "src/old.ts": "old\n" });
      const ws = await pod.workspace();
      await ws.rename("src/old.ts", "src/new.ts");
      await ws.refresh();
      expect(await readJournal(pod.fs)).toEqual({ "src/new.ts": "src/old.ts" });
      expect(ws.changes()).toEqual([
        {
          after: "old\n",
          before: "old\n",
          kind: "moved",
          loading: false,
          movedFrom: "src/old.ts",
          path: "src/new.ts",
        },
      ]);
      await ws.restore("src/new.ts");
      expect(await pod.fs.exists(projectPath("src/old.ts"))).toBe(true);
      expect(await pod.fs.exists(projectPath("src/new.ts"))).toBe(false);
      expect(await readJournal(pod.fs)).toEqual({});
      expect(ws.changes()).toEqual([]);
    });
  });

  test("a removal stages a deletion, and a discard brings the file back", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" });
      const ws = await pod.workspace();
      await ws.remove("README.md");
      expect(ws.changes()).toEqual([
        {
          after: "",
          before: "# hi\n",
          kind: "deleted",
          loading: false,
          path: "README.md",
        },
      ]);
      await ws.discard("README.md");
      expect(await pod.fs.readFile(projectPath("README.md"), "utf-8")).toBe(
        "# hi\n"
      );
      expect(ws.changes()).toEqual([]);
    });
  });

  test("a new folder is not a change", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "README.md": "# hi\n" });
      const ws = await pod.workspace();
      await ws.mkdir("src/empty/deep");
      await ws.refresh();
      expect(ws.changes()).toEqual([]);
      expect(await pod.fs.exists(projectPath("src/empty/deep"))).toBe(true);
    });
  });
});

describe("finishing with the changes", () => {
  test("discard all puts the checkout back, whatever the change was", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "a.txt": "one\n", "b.txt": "two\n" });
      const ws = await pod.workspace();
      await ws.writeText("a.txt", "edited\n");
      await ws.writeText("c.txt", "new\n");
      await ws.writeBytes("logo.png", new Uint8Array([0, 1, 2, 255]));
      await ws.rename("b.txt", "d.txt");
      await ws.refresh();
      expect(ws.changes().map((change) => change.kind)).toEqual([
        "moved",
        "modified",
        "added",
        "added",
      ]);
      await ws.discardAll();
      expect(ws.changes()).toEqual([]);
      expect(await pod.fs.readFile(projectPath("a.txt"), "utf-8")).toBe(
        "one\n"
      );
      expect(await pod.fs.exists(projectPath("c.txt"))).toBe(false);
      expect(await pod.fs.exists(projectPath("logo.png"))).toBe(false);
      expect(await pod.fs.exists(projectPath("d.txt"))).toBe(false);
      expect(await pod.fs.readFile(projectPath("b.txt"), "utf-8")).toBe(
        "two\n"
      );
      expect(await readJournal(pod.fs)).toEqual({});
    });
  });

  test("push to the pod's own branch sends the payload, re-bases on the commit and empties the panel", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "a.txt": "one\n" });
      const ws = await pod.workspace();
      await ws.writeText("a.txt", "edited\n");
      await ws.writeBytes("logo.png", new Uint8Array([0, 1, 2, 255]));
      await ws.refresh();
      const sent: PushPayload[] = [];
      await ws.push({ message: "a push", target: "main" }, (payload) => {
        sent.push(payload);
        return Promise.resolve({ sha: "commit2" });
      });
      expect(sent).toEqual([
        {
          deletes: [],
          files: [
            { content: "edited\n", path: "a.txt" },
            { content: "AAEC/w==", encoding: "base64", path: "logo.png" },
          ],
          moves: [],
        },
      ]);
      expect(ws.baseSha).toBe("commit2");
      expect(ws.changes()).toEqual([]);
      const base = await readBase(pod.fs);
      expect(base?.baseSha).toBe("commit2");
      // The pod is its own new base: the files it committed are still there.
      expect(await pod.fs.readFile(projectPath("a.txt"), "utf-8")).toBe(
        "edited\n"
      );
      expect(await readJournal(pod.fs)).toEqual({});
      await ws.refresh();
      expect(ws.changes()).toEqual([]);
    });
  });

  test("push to another branch carries the changes there and puts the pod back on its base", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "a.txt": "one\n", "b.txt": "two\n" });
      const ws = await pod.workspace();
      await ws.writeText("a.txt", "edit on a branch\n");
      await ws.writeText("new.txt", "new\n");
      await ws.rename("b.txt", "moved.txt");
      await ws.refresh();
      expect(ws.changes().map((change) => change.kind)).toEqual([
        "moved",
        "modified",
        "added",
      ]);
      const sent: PushPayload[] = [];
      await ws.push({ message: "a push", target: "topic" }, (payload) => {
        sent.push(payload);
        return Promise.resolve({ sha: "topic1" });
      });
      // The commit went to `topic` with every change on it...
      expect(sent).toHaveLength(1);
      expect(sent[0]?.files.map((file) => file.path).toSorted()).toEqual([
        "a.txt",
        "moved.txt",
        "new.txt",
      ]);
      expect(sent[0]?.moves).toEqual([{ from: "b.txt", to: "moved.txt" }]);
      // ...and this pod's own branch is untouched: the base is the commit it
      // was on, the filesystem is that commit again and the panel is empty.
      expect(ws.baseSha).toBe("tip");
      const base = await readBase(pod.fs);
      expect(base?.baseSha).toBe("tip");
      expect(ws.changes()).toEqual([]);
      expect(await pod.fs.readFile(projectPath("a.txt"), "utf-8")).toBe(
        "one\n"
      );
      expect(await pod.fs.exists(projectPath("new.txt"))).toBe(false);
      expect(await pod.fs.readFile(projectPath("b.txt"), "utf-8")).toBe(
        "two\n"
      );
      expect(await pod.fs.exists(projectPath("moved.txt"))).toBe(false);
      expect(await readJournal(pod.fs)).toEqual({});
      await ws.refresh();
      expect(ws.changes()).toEqual([]);
    });
  });

  test("the pod saves what it owes before the panel is told about it", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "a.txt": "one\n" });
      const ws = await pod.workspace();
      const off = ws.onChanges(() => {
        pod.persistence.log.push("published");
      });
      // The pod's own save is debounced: the write is in the filesystem but
      // still owed to IndexedDB when the derive runs.
      pod.persistence.pendingChanges = 1;
      await ws.refresh();
      off();
      expect(pod.persistence.log).toEqual(["saved", "published"]);
      expect(pod.persistence.pendingChanges).toBe(0);
    });
  });

  test("a derive with nothing owed does not ask the pod to save", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "a.txt": "one\n" });
      const ws = await pod.workspace();
      await ws.refresh();
      expect(pod.persistence.log).toEqual([]);
    });
  });

  test("closing the workspace saves the pod before it goes", async () => {
    await withPod(async (pod) => {
      await seed(pod.fs, { "a.txt": "one\n" });
      const ws = await pod.workspace();
      pod.persistence.pendingChanges = 1;
      expect(pod.closed()).toBe(false);
      await ws.close();
      expect(pod.persistence.log).toEqual(["saved"]);
      expect(pod.closed()).toBe(true);
    });
  });
});
