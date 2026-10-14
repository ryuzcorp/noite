import { afterEach, describe, expect, test } from "bun:test";

import { MemoryVolume } from "@r1ck404/nodepod/headless";

import { syncTabs } from "./tab-sync";
import type { TabSync } from "./tab-sync";
import { BASE_FILE, PROJECT_ROOT } from "./types";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** A pod path outside the checkout: the pod's own runtime state, which never
 * crosses between tabs. */
const POD_STATE_ROOT = "/home/.noite/state";

const open: TabSync[] = [];
afterEach(() => {
  for (const sync of open.splice(0)) {
    sync.close();
  }
});

let channels = 0;

/** Two tabs on one fresh channel, each with its own volume; the second one
 * started only when asked. */
const tabs = (startSecond = true) => {
  channels += 1;
  const name = `tab-sync-test-${channels}`;
  const one = () => {
    const volume = new MemoryVolume();
    volume.mkdirSync(PROJECT_ROOT, { recursive: true });
    const sync = syncTabs(volume, new BroadcastChannel(name));
    open.push(sync);
    return { sync, volume };
  };
  const a = one();
  const b = one();
  a.sync.start();
  if (startSecond) {
    b.sync.start();
  }
  return { a, b };
};

/** Resolves once the tab has applied peer mutations and `done` holds; with
 * the structural flag of the batch that made it hold. */
const appliedUntil = (
  sync: TabSync,
  done: () => boolean = () => true
): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let structural = false;
  const stop = sync.onApplied((moved) => {
    structural ||= moved;
    if (done()) {
      stop();
      resolve(structural);
    }
  });
  return promise;
};
const put = (volume: MemoryVolume, path: string, body: string): void => {
  volume.writeFileSync(path, ENCODER.encode(body));
};

const text = (volume: MemoryVolume, path: string): string =>
  DECODER.decode(volume.readFileSync(path));

describe("tabs on one workspace", () => {
  test("an edit, a rename and a removal in one tab land in the other", async () => {
    const { a, b } = tabs();
    const file = `${PROJECT_ROOT}/a.ts`;
    const moved = `${PROJECT_ROOT}/src/b.ts`;
    let landed = appliedUntil(b.sync, () => b.volume.existsSync(file));
    put(a.volume, file, "one");
    await landed;
    expect(text(b.volume, file)).toBe("one");

    landed = appliedUntil(a.sync, () => a.volume.existsSync(moved));
    b.volume.mkdirSync(`${PROJECT_ROOT}/src`, { recursive: true });
    b.volume.renameSync(file, moved);
    expect(await landed).toBe(true);
    expect(a.volume.existsSync(file)).toBe(false);
    expect(text(a.volume, moved)).toBe("one");

    landed = appliedUntil(
      b.sync,
      () => !b.volume.existsSync(`${PROJECT_ROOT}/src`)
    );
    a.volume.removeTreeSync(`${PROJECT_ROOT}/src`);
    await landed;
    expect(b.volume.existsSync(moved)).toBe(false);
  });

  test("an applied edit is not sent back, so the last write wins", async () => {
    const { a, b } = tabs();
    const file = `${PROJECT_ROOT}/x`;
    let batches = 0;
    a.sync.onApplied(() => {
      batches += 1;
    });
    const landed = appliedUntil(b.sync);
    put(a.volume, file, "a");
    await landed;
    // An echo of "a" would reach `a` before "b": one sender's messages
    // arrive in order.
    const back = appliedUntil(a.sync, () => text(a.volume, file) === "b");
    put(b.volume, file, "b");
    await back;
    expect(batches).toBe(1);
  });

  test("installs and paths outside the checkout stay in their own tab; the base index crosses", async () => {
    const { a, b } = tabs();
    a.volume.mkdirSync(`${PROJECT_ROOT}/node_modules/x`, { recursive: true });
    put(a.volume, `${PROJECT_ROOT}/node_modules/x/i.js`, "x");
    a.volume.mkdirSync(POD_STATE_ROOT, { recursive: true });
    put(a.volume, `${POD_STATE_ROOT}/db`, "x");
    // Sent last, so it lands last: anything shared before it is in by then.
    const landed = appliedUntil(b.sync, () => b.volume.existsSync(BASE_FILE));
    put(a.volume, BASE_FILE, "{}");
    await landed;
    expect(text(b.volume, BASE_FILE)).toBe("{}");
    expect(b.volume.existsSync(`${PROJECT_ROOT}/node_modules`)).toBe(false);
    expect(b.volume.existsSync(POD_STATE_ROOT)).toBe(false);
  });

  test("a tab applies what arrived before it started, in one batch", async () => {
    const { a, b } = tabs(false);
    const notes: boolean[] = [];
    b.sync.onApplied((structural) => {
      notes.push(structural);
    });
    // The flush answer travels behind the writes, so once it is in, so are
    // they — still unapplied, since `b` has not started.
    a.sync.serveFlush(() => Promise.resolve());
    put(a.volume, `${PROJECT_ROOT}/early`, "1");
    a.volume.mkdirSync(`${PROJECT_ROOT}/dir`, { recursive: true });
    await b.sync.flushPeers(5000);
    expect(b.volume.existsSync(`${PROJECT_ROOT}/early`)).toBe(false);
    b.sync.start();
    expect(text(b.volume, `${PROJECT_ROOT}/early`)).toBe("1");
    expect(b.volume.existsSync(`${PROJECT_ROOT}/dir`)).toBe(true);
    expect(notes).toEqual([true]);
  });

  test("a tab opening second has the saving tab flush first", async () => {
    const { a, b } = tabs(false);
    let flushed = 0;
    a.sync.serveFlush(() => {
      flushed += 1;
      return Promise.resolve();
    });
    await b.sync.flushPeers(5000);
    expect(flushed).toBe(1);
  });

  test("an applied batch reports the paths it touched, a rename its destination", async () => {
    const { a, b } = tabs();
    const file = `${PROJECT_ROOT}/a.ts`;
    const moved = `${PROJECT_ROOT}/b.ts`;
    const seen: (readonly string[])[] = [];
    b.sync.onApplied((_structural, paths) => {
      seen.push(paths);
    });
    let landed = appliedUntil(b.sync, () => b.volume.existsSync(file));
    put(a.volume, file, "one");
    await landed;
    landed = appliedUntil(b.sync, () => b.volume.existsSync(moved));
    a.volume.renameSync(file, moved);
    await landed;
    expect(seen).toEqual([[file], [moved]]);
  });
});
