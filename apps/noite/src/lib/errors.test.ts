import { expect, test } from "bun:test";

import { Cause } from "effect";

import { ApiError } from "./api";
import { errorMessage, operationMessage } from "./errors";

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

test("Effect's tryPromise wrapper reads as its cause, never the library default", () => {
  // What `Effect.tryPromise(() => api(...))` rejects with: the wrapper says
  // "An error occurred in Effect.tryPromise", the server's text is the cause.
  const wrapped = new Cause.UnknownError(
    new ApiError(422, "object store timed out while minting credentials"),
    "An error occurred in Effect.tryPromise"
  );

  expect(errorMessage(wrapped)).toBe(
    "object store timed out while minting credentials"
  );
});

test("nested wrappers peel down to the real failure", () => {
  const wrapped = new Cause.UnknownError(
    new Cause.UnknownError(new Error("runner said no")),
    "An error occurred in Effect.try"
  );

  expect(errorMessage(wrapped)).toBe("runner said no");
});

test("a server-side failure keeps its HTTP status", () => {
  expect(errorMessage(new ApiError(503, "database is unavailable"))).toBe(
    "database is unavailable (HTTP 503)"
  );

  // A 4xx message already explains the refusal; the status adds no signal.
  expect(errorMessage(new ApiError(422, "Slug is reserved"))).toBe(
    "Slug is reserved"
  );
});

test("operationMessage names the operation before the server's text", () => {
  const wrapped = new Cause.UnknownError(
    new ApiError(422, "object store timed out while minting credentials"),
    "An error occurred in Effect.tryPromise"
  );

  expect(operationMessage("Creating the app failed", wrapped)).toBe(
    "Creating the app failed: object store timed out while minting credentials"
  );
});
