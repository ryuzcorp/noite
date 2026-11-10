import { expect, test } from "bun:test";

import {
  bindIntel,
  bootIntel,
  boundPath,
  detachIntel,
  intelStarted,
  loseIntelSession,
  newIntelMachine,
  resetIntel,
} from "./intel-state";

test("ready means bound to the file on screen", () => {
  const booted = bootIntel(newIntelMachine());

  expect(intelStarted(booted.state)).toBe(true);
  expect(boundPath(booted.state)).toBeNull();

  const bound = bindIntel(booted, "a.ts");

  expect(boundPath(bound.state)).toBe("a.ts");
});

test("a new file detaches, and the next attach binds again", () => {
  const bound = bindIntel(bootIntel(newIntelMachine()), "a.ts");
  const detached = detachIntel(bound, "b.ts");

  expect(boundPath(detached.state)).toBeNull();
  // A run stamped with the old epoch is stale.
  expect(detached.epoch).toBeGreaterThan(bound.epoch);

  const rebound = bindIntel(detached, "b.ts");

  expect(boundPath(rebound.state)).toBe("b.ts");
});

test("a session that threw is not ready, but the program is not reset", () => {
  const bound = bindIntel(bootIntel(newIntelMachine()), "a.ts");
  const lost = loseIntelSession(bound);

  expect(boundPath(lost.state)).toBeNull();
  expect(lost.epoch).toBe(bound.epoch);
  expect(intelStarted(lost.state)).toBe(true);
});

test("a push resets the worker and the started latch with it", () => {
  const bound = bindIntel(bootIntel(newIntelMachine()), "a.ts");
  const reset = resetIntel(bound);

  expect(intelStarted(reset.state)).toBe(false);
  expect(reset.epoch).toBeGreaterThan(bound.epoch);
  // Booting again from Off is a new epoch.
  const rebooted = bootIntel(reset);

  expect(rebooted.epoch).toBeGreaterThan(reset.epoch);
});
