import { describe, expect, test } from "bun:test";

import { HARNESS_STATE_DIR } from "../preview/server";
import type {
  MirrorMutation,
  MirrorStorage,
  MirrorVolume,
} from "./state-mirror";
import {
  MIRRORED_STATE_ROOT,
  PREVIEW_STATE,
  UNSAVED_PROJECT,
  clearMirror,
  mirrorStorage,
  restoreMirror,
  startMirror,
} from "./state-mirror";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** An in-memory volume speaking the mirror's synchronous slice. Directories
 * are implied by the files under them. */
interface FakeVolume extends MirrorVolume {
  emit: (mutation: MirrorMutation) => void;
  text: (path: string) => string | null;
}

const fakeVolume = (): FakeVolume => {
  const files = new Map<string, Uint8Array>();
  const listeners = new Set<(mutation: MirrorMutation) => void>();
  const under = (path: string): string[] =>
    [...files.keys()].filter((key) => key.startsWith(`${path}/`));
  return {
    emit: (mutation) => {
      for (const listener of listeners) {
        listener(mutation);
      }
    },
    existsSync: (path) => files.has(path) || under(path).length > 0,
    mkdirSync: () => {
      // Directories are implied by their files.
    },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- the fake delivers mutations as events, like the volume
    onMutation: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    readFileSync: (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return bytes;
    },
    readdirSync: (path) => {
      const children = under(path);
      if (children.length === 0) {
        throw new Error(`ENOENT: ${path}`);
      }
      return [
        ...new Set(
          children.map((key) => key.slice(path.length + 1).split("/")[0] ?? "")
        ),
      ];
    },
    removeTreeSync: (path) => {
      files.delete(path);
      for (const key of under(path)) {
        files.delete(key);
      }
    },
    text: (path) => {
      const bytes = files.get(path);
      return bytes === undefined ? null : DECODER.decode(bytes);
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
    },
  };
};

const fakeStorage = (): MirrorStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

/** Write `text` at `path` the way the pod would: bytes first, then the
 * mutation the mirror records. */
const put = (volume: FakeVolume, path: string, text: string): void => {
  volume.writeFileSync(path, ENCODER.encode(text));
  volume.emit({ op: "write", path });
};

const ID = "noite:app:main";

/** The saved copy a reload restores before the mirror is overlaid. */
const savedCopy = (): FakeVolume => {
  const volume = fakeVolume();
  volume.writeFileSync("/home/project/util.ts", ENCODER.encode("old"));
  volume.writeFileSync("/home/project/gone.ts", ENCODER.encode("old"));
  volume.writeFileSync("/home/project/lib/a.ts", ENCODER.encode("a"));
  return volume;
};

describe("preview state mirror", () => {
  test("tracks the preview server's state directory", () => {
    expect(MIRRORED_STATE_ROOT).toBe(HARNESS_STATE_DIR);
  });

  test("records writes and restores them after a reload", () => {
    const storage = fakeStorage();
    const before = fakeVolume();
    const mirror = startMirror(before, PREVIEW_STATE, ID, storage);
    put(before, "/home/.noite/s/db/do-abc.sqlite", "counter-bytes");
    put(before, "/home/.noite/s/r2/uploads/test.txt", "hello");
    put(before, "/home/project/index.ts", "not preview state");
    mirror.stop();

    const after = fakeVolume();
    expect(restoreMirror(after, PREVIEW_STATE, ID, storage)).toBe(2);
    expect(after.text("/home/.noite/s/db/do-abc.sqlite")).toBe("counter-bytes");
    expect(after.text("/home/.noite/s/r2/uploads/test.txt")).toBe("hello");
    expect(after.text("/home/project/index.ts")).toBe(null);
  });

  test("follows R2's write-then-rename and skips SQLite sidecars", () => {
    const storage = fakeStorage();
    const before = fakeVolume();
    const mirror = startMirror(before, PREVIEW_STATE, ID, storage);
    put(before, "/home/.noite/s/r2/uploads/data.tmp-1", "staged");
    // A rename lands its bytes atomically: the destination reads back at
    // the mutation, so the fake moves the bytes before emitting it.
    before.writeFileSync(
      "/home/.noite/s/r2/uploads/data",
      ENCODER.encode("staged")
    );
    before.emit({
      from: "/home/.noite/s/r2/uploads/data.tmp-1",
      op: "rename",
      to: "/home/.noite/s/r2/uploads/data",
    });
    put(before, "/home/.noite/s/db/d1-abc.sqlite", "committed");
    put(before, "/home/.noite/s/db/d1-abc.sqlite-journal", "rollback-pages");
    mirror.stop();

    const after = fakeVolume();
    restoreMirror(after, PREVIEW_STATE, ID, storage);
    expect(after.text("/home/.noite/s/r2/uploads/data")).toBe("staged");
    expect(after.text("/home/.noite/s/r2/uploads/data.tmp-1")).toBe(null);
    expect(after.text("/home/.noite/s/db/d1-abc.sqlite")).toBe("committed");
    expect(after.text("/home/.noite/s/db/d1-abc.sqlite-journal")).toBe(null);
  });

  test("a corrupt or cleared mirror restores nothing, and storage may be absent", () => {
    const storage = fakeStorage();
    storage.setItem(`noite:preview-state:${ID}`, "{broken");
    expect(restoreMirror(fakeVolume(), PREVIEW_STATE, ID, storage)).toBe(0);

    const volume = fakeVolume();
    const mirror = startMirror(volume, PREVIEW_STATE, ID, storage);
    put(volume, "/home/.noite/s/db/do-abc.sqlite", "n");
    mirror.stop();
    clearMirror(PREVIEW_STATE, ID, storage);
    expect(restoreMirror(fakeVolume(), PREVIEW_STATE, ID, storage)).toBe(0);

    const without = fakeVolume();
    const none = startMirror(without, PREVIEW_STATE, ID, null);
    put(without, "/home/.noite/s/db/do-abc.sqlite", "n");
    none.stop();
    expect(restoreMirror(fakeVolume(), PREVIEW_STATE, ID, null)).toBe(0);
    expect(mirrorStorage()).toBe(null);
  });
});

describe("unsaved project mirror", () => {
  test("an edit IndexedDB has not saved yet survives a reload", () => {
    const storage = fakeStorage();
    const before = savedCopy();
    const mirror = startMirror(before, UNSAVED_PROJECT, ID, storage);
    put(before, "/home/project/util.ts", "// kept across reload");
    put(before, "/home/project/node_modules/x/index.js", "installed");

    const after = savedCopy();
    restoreMirror(after, UNSAVED_PROJECT, ID, storage);
    expect(after.text("/home/project/util.ts")).toBe("// kept across reload");
    expect(after.text("/home/project/node_modules/x/index.js")).toBe(null);
    mirror.stop();
  });

  test("a delete or a folder rename is not undone by the older saved copy", () => {
    const storage = fakeStorage();
    const before = savedCopy();
    const mirror = startMirror(before, UNSAVED_PROJECT, ID, storage);
    before.removeTreeSync("/home/project/gone.ts");
    before.emit({ op: "remove", path: "/home/project/gone.ts" });
    // A renamed folder is one mutation; its files are read under the new name.
    before.removeTreeSync("/home/project/lib");
    before.writeFileSync("/home/project/src/a.ts", ENCODER.encode("a"));
    before.emit({
      from: "/home/project/lib",
      op: "rename",
      to: "/home/project/src",
    });

    const after = savedCopy();
    restoreMirror(after, UNSAVED_PROJECT, ID, storage);
    expect(after.text("/home/project/gone.ts")).toBe(null);
    expect(after.text("/home/project/lib/a.ts")).toBe(null);
    expect(after.text("/home/project/src/a.ts")).toBe("a");
    expect(after.text("/home/project/util.ts")).toBe("old");
    mirror.stop();
  });

  test("once saved, the mirror is emptied and records again", () => {
    const storage = fakeStorage();
    const before = savedCopy();
    const mirror = startMirror(before, UNSAVED_PROJECT, ID, storage);
    put(before, "/home/project/util.ts", "saved since");
    mirror.clear();
    expect(restoreMirror(savedCopy(), UNSAVED_PROJECT, ID, storage)).toBe(0);

    put(before, "/home/project/util.ts", "newer, unsaved");
    const after = savedCopy();
    restoreMirror(after, UNSAVED_PROJECT, ID, storage);
    expect(after.text("/home/project/util.ts")).toBe("newer, unsaved");
    mirror.stop();
  });
});
