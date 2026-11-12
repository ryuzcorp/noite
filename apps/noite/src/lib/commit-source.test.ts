import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { ApiError } from "./api";
import { commitSource } from "./commit-source";
import { errorMessage } from "./errors";

let restore: (() => void) | null = null;

/** Replace `fetch` for one test; `afterEach` puts the real one back. */
const stubFetch = (respond: () => Promise<Response>) => {
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: () => {} })
  );

  restore = () => {
    spy.mockRestore();
  };
};

afterEach(() => {
  restore?.();
  restore = null;
});

const input = {
  appId: "app-1",
  files: [{ content: "{}", path: "package.json" }],
  message: "Upload shop",
};

describe("the web-commit client", () => {
  test("answers the route's sha on success", async () => {
    stubFetch(() => Promise.resolve(Response.json({ sha: "abc1234" })));

    await expect(commitSource(input)).resolves.toEqual({ sha: "abc1234" });
  });

  test("a refusal keeps the runner's message and the HTTP status", async () => {
    stubFetch(() =>
      Promise.resolve(
        Response.json({ error: "database is unavailable" }, { status: 503 })
      )
    );

    let failure: unknown;

    try {
      await commitSource(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ApiError);
    expect(errorMessage(failure)).toBe("database is unavailable (HTTP 503)");
  });

  test("a plain-text refusal is shown as written", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("forbidden", { status: 403 }))
    );

    await expect(commitSource(input)).rejects.toThrow("forbidden");
  });

  test("a dropped connection names the network failure", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    await expect(commitSource(input)).rejects.toThrow(
      "network error: Failed to fetch"
    );
  });
});
