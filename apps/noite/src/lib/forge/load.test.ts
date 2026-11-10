import { expect, test } from "bun:test";

import { loadState } from "./load";

test("a cold reader is loading", () => {
  expect(loadState<string>({ _tag: "Loading" })).toEqual({ _tag: "Loading" });
});

test("ready and reloading both paint their value", () => {
  expect(loadState<string>({ _tag: "Ready", value: "rows" })).toEqual({
    _tag: "Ready",
    value: "rows",
  });
  // A reload keeps the last value visible: it is not a skeleton.
  expect(loadState<string>({ _tag: "Reloading", value: "rows" })).toEqual({
    _tag: "Ready",
    value: "rows",
  });
});

test("a failure carries its message", () => {
  expect(
    loadState<string>({
      _tag: "Failed",
      error: new Error("no such ref"),
      value: undefined,
    })
  ).toEqual({ _tag: "Failed", message: "no such ref" });
});

test("a caught non-Error still yields text", () => {
  const loaded = loadState<string>({
    _tag: "Failed",
    error: "boom",
    value: undefined,
  });

  expect(loaded._tag).toBe("Failed");
  expect(loaded._tag === "Failed" ? loaded.message : "").not.toBe("");
});
