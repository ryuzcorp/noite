import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { ApiError } from "./api";
import { api } from "./api";

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

/** The rejection as `ApiError`, failing the test when the call resolves. */
const rejection = async (call: Promise<unknown>): Promise<ApiError> => {
  try {
    await call;
  } catch (error) {
    // SAFETY: `api()` rejects only with ApiError; this asserts that at the seam.
    return error as ApiError;
  }

  throw new Error("the call was expected to reject");
};

describe("the JSON-action client", () => {
  test("answers the action's value on success", async () => {
    stubFetch(() => Promise.resolve(Response.json({ id: "app-1" })));

    await expect(api("/api/apps/create", {})).resolves.toEqual({ id: "app-1" });
  });

  test("a 500 keeps the server's own error text and status", async () => {
    stubFetch(() =>
      Promise.resolve(
        Response.json(
          { error: "object store timed out while minting credentials" },
          { status: 500 }
        )
      )
    );

    const error = await rejection(api("/api/apps/create", {}));

    expect(error.message).toBe(
      "object store timed out while minting credentials"
    );
    expect(error.status).toBe(500);
  });

  test("a 422 paints its field errors", async () => {
    stubFetch(() =>
      Promise.resolve(
        Response.json(
          { errors: { form: "Slug is reserved", slug: "Already taken" } },
          { status: 422 }
        )
      )
    );

    const error = await rejection(api("/api/apps/create", {}));

    expect(error.message).toBe("Slug is reserved. Already taken");
    expect(error.errors).toEqual({
      form: "Slug is reserved",
      slug: "Already taken",
    });
  });

  test("a network failure names the network, not the fetch library", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    const error = await rejection(api("/api/apps/create", {}));

    expect(error.message).toBe("network error: Failed to fetch");
    expect(error.status).toBe(0);
  });

  test("a body that stalls after the headers is the same timeout", async () => {
    // The abort signal covers the body read too: `fetch` already resolved.
    // SAFETY: only `ok`, `status` and a rejecting `json` are read by `api`.
    stubFetch(() =>
      Promise.resolve({
        json: () =>
          Promise.reject(
            new DOMException("The operation was aborted", "AbortError")
          ),
        ok: true,
        status: 200,
      } as Response)
    );

    const error = await rejection(api("/api/apps/create", {}));

    expect(error.message).toBe("the server didn't answer within 20 s");
  });

  test("a malformed answer is a protocol failure, not a timeout", async () => {
    stubFetch(() => Promise.resolve(new Response("not json")));

    const error = await rejection(api("/api/apps/create", {}));

    expect(error.message).toBe("the server sent an unreadable answer");
    expect(error.status).toBe(200);
  });

  test("a timeout says how long the wait was, never hangs", async () => {
    stubFetch(() =>
      Promise.reject(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        )
      )
    );

    const error = await rejection(api("/api/apps/create", {}));

    expect(error.message).toBe("the server didn't answer within 20 s");
    expect(error.status).toBe(0);
  });
});
