//! The preview's live command lines: spawns add oldest-first, an exit drops
//! only its own line, an unknown child is a no-op, and halt clears the rest.

import { describe, expect, test } from "bun:test";

import { liveCommands } from "./processes";
import type { PreviewProcess } from "./types";

const child = (name: string): PreviewProcess =>
  // SAFETY: the ledger only keeps the handle for identity; no process method ever runs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- identity-only double, cast at the boundary.
  ({ name }) as unknown as PreviewProcess;

describe("liveCommands", () => {
  test("adds lines oldest-first", () => {
    const commands = liveCommands();
    commands.add(child("first"), "node a.mjs");
    commands.add(child("second"), "node b.mjs");
    expect(commands.lines()).toEqual(["node a.mjs", "node b.mjs"]);
  });

  test("an exit drops only its own line", () => {
    const commands = liveCommands();
    const first = child("first");
    const second = child("second");
    commands.add(first, "node a.mjs");
    commands.add(second, "node b.mjs");
    commands.remove(first);
    expect(commands.lines()).toEqual(["node b.mjs"]);
  });

  test("removing an unknown child is a no-op", () => {
    const commands = liveCommands();
    commands.add(child("first"), "node a.mjs");
    commands.remove(child("gone"));
    expect(commands.lines()).toEqual(["node a.mjs"]);
  });

  test("clear drops every line", () => {
    const commands = liveCommands();
    commands.add(child("first"), "node a.mjs");
    commands.add(child("second"), "node b.mjs");
    commands.clear();
    expect(commands.lines()).toEqual([]);
  });
});
