import { expect, test } from "bun:test";

import { Cause } from "effect";

import { ApiError } from "./api";
import {
  errorLogText,
  errorMessage,
  isQueryFailure,
  operationMessage,
} from "./errors";

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

/** Drizzle's `DrizzleQueryError`: the wrapper's message is the SQL text and
 * every bound parameter, the driver failure is the `cause`. */
const queryError = (): Error =>
  Object.assign(
    new Error(
      `Failed query: insert into "app_collaborator" ("appId","userId") values (?,?)\nparams: app-1,u-creator`
    ),
    {
      cause: new Error("UNIQUE constraint failed: app_collaborator.appId"),
      params: ["app-1", "u-creator"],
      query: 'insert into "app_collaborator" ("appId","userId") values (?,?)',
    }
  );

test("a wrapped query error reads as one fixed text, never its SQL or names", () => {
  const wrapped = new Cause.UnknownError(
    queryError(),
    "An error occurred in Effect.tryPromise"
  );

  expect(errorMessage(wrapped)).toBe("Database query failed");
  expect(errorMessage(queryError())).toBe("Database query failed");
  expect(errorMessage(wrapped)).not.toContain("Failed query");
  expect(errorMessage(wrapped)).not.toContain("params:");
});

test("isQueryFailure sees the query through effect's wrapper", () => {
  expect(isQueryFailure(queryError())).toBe(true);
  expect(
    isQueryFailure(
      new Cause.UnknownError(
        queryError(),
        "An error occurred in Effect.tryPromise"
      )
    )
  ).toBe(true);
  expect(isQueryFailure(new Error("D1 is down"))).toBe(false);
  expect(isQueryFailure(null)).toBe(false);
});

test("the server log keeps the cause and drops the query's SQL and params", () => {
  const log = errorLogText(
    new Cause.UnknownError(
      queryError(),
      "An error occurred in Effect.tryPromise"
    )
  );

  expect(log).toContain("An error occurred");
  expect(log).toContain("Caused by:");
  expect(log).toContain("UNIQUE constraint failed: app_collaborator.appId");

  // F1: an auth-table write binds credentials, and the wrapper's own stack is
  // the statement plus every parameter.
  for (const leak of ["Failed query", "params:", "insert into"]) {
    expect(log).not.toContain(leak);
  }

  expect(errorLogText(queryError())).not.toContain("Failed query");
  expect(errorLogText(queryError())).not.toContain("params:");
});

test("a query error with no driver cause never reads as its SQL", () => {
  const bare = Object.assign(new Error("Failed query: select * from secret"), {
    params: ["secret"],
    query: "select * from secret",
  });

  expect(errorMessage(bare)).toBe("Database query failed");
});
