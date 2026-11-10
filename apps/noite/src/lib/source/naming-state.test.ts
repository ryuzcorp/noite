import { expect, test } from "bun:test";

import {
  clearNaming,
  finishNaming,
  newNamingMachine,
  refuseNaming,
  settleNaming,
  startNaming,
} from "./naming-state";
import type { PendingAdd } from "./naming-state";

const add: PendingAdd = { isFolder: false, path: "untitled" };

test("a second add is refused while one is being named", () => {
  const first = startNaming(newNamingMachine(), add);

  expect(first.accepted).toBe(true);

  const second = startNaming(first.machine, {
    isFolder: true,
    path: "new-folder",
  });

  expect(second.accepted).toBe(false);
  expect(second.machine).toBe(first.machine);
});

test("a late rename of a refused placeholder is swallowed, never a move", () => {
  const started = startNaming(newNamingMachine(), add).machine;
  const refused = refuseNaming(started, '"untitled" already exists.');

  expect(refused.drop).toBe("untitled");
  expect(refused.notify).toBe('"untitled" already exists.');

  // pierre reports the rename after its refusal (the callback order is its
  // own): this used to reach `workspace().rename()` for a path the pod never
  // had.
  const late = finishNaming(refused.machine, {
    destinationPath: "renamed",
    isFolder: false,
    sourcePath: "untitled",
  });

  expect(late.refused).toBe(true);
  expect(late.rename).toBeNull();
  expect(late.land).toBeNull();
});

test("a rename after the tree was rebuilt is not a move either", () => {
  const started = startNaming(newNamingMachine(), add).machine;
  const cleared = clearNaming(started);

  const late = finishNaming(cleared, {
    destinationPath: "renamed",
    isFolder: false,
    sourcePath: "untitled",
  });

  expect(late.rename).toBeNull();
  expect(late.land).toBeNull();
});

test("a rename of a row the checkout had is mirrored as a move", () => {
  const decision = finishNaming(newNamingMachine(), {
    destinationPath: "src/b.ts",
    isFolder: false,
    sourcePath: "src/a.ts",
  });

  expect(decision.rename?.destinationPath).toBe("src/b.ts");
  expect(decision.land).toBeNull();
});

test("the placeholder's own rename lands as the new file", () => {
  const started = startNaming(newNamingMachine(), add).machine;

  const landed = finishNaming(started, {
    destinationPath: "main.ts",
    isFolder: false,
    sourcePath: "untitled",
  });

  expect(landed.land).toEqual({ isFolder: false, path: "main.ts" });
  expect(landed.machine.state._tag).toBe("Landed");
});

test("an untouched name settles into a land at most once", () => {
  const started = startNaming(newNamingMachine(), add).machine;
  const settled = settleNaming(started, add, true);

  expect(settled.land).toEqual(add);

  const again = settleNaming(settled.machine, add, true);

  expect(again.refused).toBe(true);
  expect(again.land).toBeNull();
});
