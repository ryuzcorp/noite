import { expect, test } from "bun:test";

import { errorMessage } from "./errors";

test("an Error reads as its message", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
});

test("strings pass through", () => {
  expect(errorMessage("plain")).toBe("plain");
});

test("non-Error values stringify", () => {
  expect(errorMessage(null)).toBe("null");
  expect(errorMessage(42)).toBe("42");
});
