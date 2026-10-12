import { describe, expect, test } from "bun:test";

import { HARNESS_STATE_DIR } from "../preview/server";
import type {
  MirrorMutation,
  MirrorStorage,
  MirrorVolume,
} from "./state-mirror";
import {
  MIRRORED_STATE_ROOT,
  clearMirroredState,
  mirrorStateDir,
  mirrorStorage,
  restoreMirroredState,
} from "./state-mirror";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** An in-memory volume speaking the mirror's synchronous slice. */
interface FakeVolume extends MirrorVolume {
  emit: (mutation: MirrorMutation) => void;
  text: (path: string) => string | null;
}

const fakeVolume = (): FakeVolume => {
  const files = new Map<string, Uint8Array>();
  const listeners = new Set<(mutation: MirrorMutation) => void>();
  return {
    emit: (mutation) => {
      for (const listener of listeners) {
        listener(mutation);
      }
    },
    mkdirSync: () => {
      // The fake keeps no directories; files carry their own paths.
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

describe("state mirror", () => {
  test("tracks the preview server's state directory", () => {
    expect(MIRRORED_STATE_ROOT).toBe(HARNESS_STATE_DIR);
  });

  test("records writes and restores them after a reload", () => {
    const id = "noite:app:main";
    const storage = fakeStorage();
    const before = fakeVolume();
    const stop = mirrorStateDir(before, id, storage);
    put(before, "/home/.noite/s/db/do-abc.sqlite", "counter-bytes");
    put(before, "/home/.noite/s/r2/uploads/test.txt", "hello");
    put(before, "/home/project/index.ts", "not preview state");
    stop();

    const after = fakeVolume();
    const restored = restoreMirroredState(after, id, storage);
    expect(restored).toBe(2);
    expect(after.text("/home/.noite/s/db/do-abc.sqlite")).toBe("counter-bytes");
    expect(after.text("/home/.noite/s/r2/uploads/test.txt")).toBe("hello");
    expect(after.text("/home/project/index.ts")).toBe(null);
  });

  test("follows renames and removals, including R2's tmp pattern", () => {
    const id = "noite:app:main";
    const storage = fakeStorage();
    const before = fakeVolume();
    const stop = mirrorStateDir(before, id, storage);
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
    put(before, "/home/.noite/s/r2/uploads/gone.txt", "bye");
    before.emit({ op: "remove", path: "/home/.noite/s/r2/uploads/gone.txt" });
    stop();

    const after = fakeVolume();
    restoreMirroredState(after, id, storage);
    expect(after.text("/home/.noite/s/r2/uploads/data")).toBe("staged");
    expect(after.text("/home/.noite/s/r2/uploads/data.tmp-1")).toBe(null);
    expect(after.text("/home/.noite/s/r2/uploads/gone.txt")).toBe(null);
  });

  test("skips SQLite sidecars and drops a corrupt mirror", () => {
    const id = "noite:app:main";
    const storage = fakeStorage();
    const before = fakeVolume();
    const stop = mirrorStateDir(before, id, storage);
    put(before, "/home/.noite/s/db/d1-abc.sqlite", "committed");
    put(before, "/home/.noite/s/db/d1-abc.sqlite-journal", "rollback-pages");
    stop();

    const after = fakeVolume();
    restoreMirroredState(after, id, storage);
    expect(after.text("/home/.noite/s/db/d1-abc.sqlite")).toBe("committed");
    expect(after.text("/home/.noite/s/db/d1-abc.sqlite-journal")).toBe(null);

    storage.setItem("noite:preview-state:noite:app:main", "{broken");
    const empty = fakeVolume();
    expect(restoreMirroredState(empty, id, storage)).toBe(0);
  });

  test("a forgotten workspace forgets its mirror, and storage may be absent", () => {
    const id = "noite:app:main";
    const storage = fakeStorage();
    const volume = fakeVolume();
    const stop = mirrorStateDir(volume, id, storage);
    put(volume, "/home/.noite/s/db/do-abc.sqlite", "n");
    stop();
    clearMirroredState(id, storage);
    expect(restoreMirroredState(fakeVolume(), id, storage)).toBe(0);

    const without = fakeVolume();
    const stopNothing = mirrorStateDir(without, id, null);
    put(without, "/home/.noite/s/db/do-abc.sqlite", "n");
    stopNothing();
    expect(restoreMirroredState(fakeVolume(), id, null)).toBe(0);
    expect(mirrorStorage()).toBe(null);
  });
});
