import { expect, test } from "bun:test";

import { errorMessage } from "./errors";

test("an Error reads as its message", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
});

test("an action's plain { message } object is not [object Object]", () => {
  expect(
    errorMessage({ _tag: "ActionError", message: "Slug is reserved" })
  ).toBe("Slug is reserved");
});

test("strings pass through", () => {
  expect(errorMessage("plain")).toBe("plain");
});

test("other values are serialised, never [object Object]", () => {
  expect(errorMessage({ code: 42 })).toBe('{"code":42}');
  expect(errorMessage(null)).toBe("null");
});

interface Loop {
  self?: Loop;
}

test("a circular value still yields text", () => {
  const loop: Loop = {};
  loop.self = loop;
  expect(errorMessage(loop)).toBeTypeOf("string");
});
