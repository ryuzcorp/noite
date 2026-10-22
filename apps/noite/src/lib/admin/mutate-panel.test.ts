//! `mutatePanel` reloads the panel list after every mutation — success or
//! failure — so a mutation that finished server-side while the client timed
//! out never leaves a stale row behind the error banner.

import { describe, expect, test } from "bun:test";

import type { AtomHandle } from "ilha";

import { mutatePanel } from "./shared";

/** The `AtomHandle` surface `mutatePanel` touches (read + set). */
const testAtom = <T>(initial: T): AtomHandle<T> => {
  let value = initial;
  // SAFETY: the helper under test only reads and sets; nothing else observes this handle.
  const handle = (() => value) as AtomHandle<T>;
  handle.set = (next: T): void => {
    value = next;
  };

  return handle;
};

describe("mutatePanel", () => {
  test("reloads after a successful mutation", async () => {
    const busy = testAtom(false);
    const panelError = testAtom("");
    let refetches = 0;
    let busyDuringWork = false;
    await mutatePanel(
      busy,
      panelError,
      () => {
        refetches += 1;

        return Promise.resolve();
      },
      () => {
        busyDuringWork = busy();

        return Promise.resolve();
      }
    );
    expect(refetches).toBe(1);
    expect(panelError()).toBe("");
    expect(busyDuringWork).toBe(true);
    expect(busy()).toBe(false);
  });

  test("reloads after a failed mutation and keeps the error", async () => {
    const busy = testAtom(false);
    const panelError = testAtom("");
    let refetches = 0;
    await mutatePanel(
      busy,
      panelError,
      () => {
        refetches += 1;

        return Promise.resolve();
      },
      () => Promise.reject(new Error("delete timed out"))
    );
    expect(refetches).toBe(1);
    expect(panelError()).toBe("delete timed out");
    expect(busy()).toBe(false);
  });

  test("a failed reload never masks the mutation error", async () => {
    const busy = testAtom(false);
    const panelError = testAtom("");
    await mutatePanel(
      busy,
      panelError,
      () => Promise.reject(new Error("reload blew up")),
      () => Promise.reject(new Error("delete timed out"))
    );
    expect(panelError()).toBe("delete timed out");
    expect(busy()).toBe(false);
  });
});
