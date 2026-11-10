import { expect, test } from "bun:test";

import {
  finishUpload,
  newUploadMachine,
  pickChanged,
  startDrop,
  startPick,
  startWriting,
  uploadBusy,
} from "./upload-run";

test("the folder is captured at the pick, and a change answers only it", () => {
  const first = startPick(newUploadMachine(), "src");

  expect(first.picked).toBe(true);
  expect(uploadBusy(first.machine.state)).toBe(true);

  // A second pick while the picker is open cannot retarget the first one.
  expect(startPick(first.machine, "docs").picked).toBe(false);

  const token =
    first.machine.state._tag === "Picking" ? first.machine.state.token : -1;

  const changed = pickChanged(first.machine, token);

  expect(changed.dir).toBe("src");
  // A stale token answers nothing.
  expect(pickChanged(first.machine, token + 1).dir).toBeNull();
});

test("a drop while a run is in flight is refused, not interleaved", () => {
  const picked = startPick(newUploadMachine(), "src").machine;
  const token = picked.state._tag === "Picking" ? picked.state.token : -1;

  const reading = pickChanged(picked, token).machine;

  expect(startDrop(reading, "docs").started).toBe(false);

  const writing = startWriting(reading);

  expect(writing.state._tag).toBe("Writing");
  expect(startDrop(writing, "docs").started).toBe(false);
  expect(startPick(writing, "docs").picked).toBe(false);
});

test("an idle run takes a drop, and finishing frees the slot", () => {
  const dropped = startDrop(newUploadMachine(), "");

  expect(dropped.started).toBe(true);
  expect(dropped.machine.state._tag).toBe("Reading");

  const done = finishUpload(dropped.machine);

  expect(uploadBusy(done.state)).toBe(false);
  expect(startDrop(done, "docs").started).toBe(true);
});
