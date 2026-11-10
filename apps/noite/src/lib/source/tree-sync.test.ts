import { expect, test } from "bun:test";

import { askResync, finishResync, ResyncStates } from "./tree-sync";

test("the first ask runs, the next is queued", () => {
  const first = askResync(ResyncStates.Idle());

  expect(first.run).toBe(true);
  expect(first.state).toEqual(ResyncStates.Running({ queued: false }));

  const second = askResync(first.state);

  expect(second.run).toBe(false);
  expect(second.state).toEqual(ResyncStates.Running({ queued: true }));
});

test("the run after a mid-run ask is owed exactly once", () => {
  const queued = askResync(askResync(ResyncStates.Idle()).state).state;
  const finished = finishResync(queued);

  expect(finished.run).toBe(true);
  expect(finished.state).toEqual(ResyncStates.Running({ queued: false }));

  const drained = finishResync(finished.state);

  expect(drained.run).toBe(false);
  expect(drained.state._tag).toBe("Idle");
});

test("two mid-run asks still answer with one run", () => {
  const once = askResync(ResyncStates.Idle()).state;
  const twice = askResync(askResync(once).state).state;

  expect(twice).toEqual(ResyncStates.Running({ queued: true }));
  expect(finishResync(twice).run).toBe(true);
  expect(finishResync(finishResync(twice).state).run).toBe(false);
});
