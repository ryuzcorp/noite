import { expect, test } from "bun:test";

import {
  hoverEnter,
  hoverExpired,
  hoverHide,
  hoverLeave,
  hoverOpen,
  hoverPainted,
  hoverRest,
  newHoverMachine,
} from "./hover-state";

test("a pointer that left before the answer landed opens nothing", () => {
  const entered = hoverEnter(newHoverMachine(), "a:1");
  const { machine } = hoverLeave(entered);

  // The answer arrives after the leave: no epoch to paint under.
  expect(hoverRest(machine, "a:1").epoch).toBeNull();
  expect(hoverOpen(machine.state)).toBe(false);

  // And a paint under the pre-leave epoch cannot open either.
  const { epoch } = hoverEnter(newHoverMachine(), "a:1");

  const painted = hoverPainted(
    hoverLeave(hoverEnter(newHoverMachine(), "a:1")).machine,
    epoch
  );

  expect(painted.open).toBe(false);
});

test("a rested token paints under its epoch and opens", () => {
  const entered = hoverEnter(newHoverMachine(), "a:1");
  const rested = hoverRest(entered, "a:1");

  expect(rested.epoch).not.toBeNull();

  const painted = hoverPainted(rested.machine, rested.epoch ?? -1);

  expect(painted.open).toBe(true);
  expect(hoverOpen(painted.machine.state)).toBe(true);
});

test("an answer for a superseded token is refused", () => {
  const first = hoverEnter(newHoverMachine(), "a:1");
  const second = hoverEnter(first, "a:2");

  expect(hoverRest(second, "a:1").epoch).toBeNull();
});

test("the grace period closes only the tip that armed it", () => {
  const entered = hoverEnter(newHoverMachine(), "a:1");
  const rested = hoverRest(entered, "a:1");
  const shown = hoverPainted(rested.machine, rested.epoch ?? -1).machine;

  const left = hoverLeave(shown);

  expect(left.linger).toBe(true);

  const epoch =
    left.machine.state._tag === "Lingering" ? left.machine.state.epoch : -1;

  // A newer enter invalidates the old grace period.
  const reentered = hoverEnter(left.machine, "a:2");

  expect(hoverExpired(reentered, epoch).close).toBe(false);
  expect(hoverExpired(left.machine, epoch).close).toBe(true);
});

test("hide invalidates everything in flight", () => {
  const entered = hoverEnter(newHoverMachine(), "a:1");
  const hidden = hoverHide(entered);

  expect(hoverRest(hidden, "a:1").epoch).toBeNull();
  expect(hidden.state._tag).toBe("Idle");
});
