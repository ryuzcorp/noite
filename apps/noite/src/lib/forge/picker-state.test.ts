import { expect, test } from "bun:test";

import {
  failAction,
  pickerBusy,
  pickerError,
  PickerStates,
  reopenPicker,
  settleAction,
  startAction,
} from "./picker-state";

test("a failure clears when the dropdown is reopened", () => {
  const failed = failAction(
    startAction(PickerStates.Idle(), "create", "feature"),
    "name already exists"
  );

  expect(pickerError(failed)).toBe("name already exists");
  expect(pickerBusy(failed)).toBe(false);

  // Reopening the dropdown (or picking a ref) leaves the gesture behind.
  expect(pickerError(reopenPicker(failed))).toBe("");
});

test("a second action cannot start while one is running", () => {
  const busy = startAction(PickerStates.Idle(), "delete-confirm", "feature");

  expect(pickerBusy(busy)).toBe(true);
  // A second delete click cannot stack a second dialog.
  expect(startAction(busy, "delete-confirm", "feature")).toBe(busy);
  expect(startAction(busy, "create", "other")).toBe(busy);
});

test("settling frees the slot for the next action", () => {
  const busy = startAction(PickerStates.Idle(), "delete", "feature");
  const settled = settleAction(busy);

  expect(pickerBusy(settled)).toBe(false);
  expect(startAction(settled, "create", "other")).toEqual(
    PickerStates.Busy({ action: "create", ref: "other" })
  );
});

test("an outcome that does not belong to a running action is refused", () => {
  const idle = PickerStates.Idle();

  expect(failAction(idle, "boom")).toBe(idle);
  expect(settleAction(idle)).toBe(idle);
});
