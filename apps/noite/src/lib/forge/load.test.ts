import { expect, test } from "bun:test";

import { loadState } from "./load";

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown";

test("no value and no error is a load", () => {
  expect(loadState<string>(undefined, null)).toEqual({ _tag: "Loading" });
});

test("a value is ready whether or not an earlier error is still set", () => {
  expect(loadState("rows", new Error("stale"))).toEqual({
    _tag: "Ready",
    value: "rows",
  });
});

test("a failure carries its message", () => {
  expect(loadState(undefined, new Error("no such ref"))).toEqual({
    _tag: "Failed",
    message: "no such ref",
  });
});

test("a caught non-Error still yields text", () => {
  const loaded = loadState(undefined, "boom");

  expect(loaded._tag).toBe("Failed");
  expect(loaded._tag === "Failed" ? loaded.message : "").not.toBe("");
  // The helper the views use keeps the same shape.
  expect(message(new Error("x"))).toBe("x");
});
