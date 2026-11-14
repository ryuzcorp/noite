import { describe, expect, test } from "bun:test";

import { RunnerHttpError } from "../runner";
import { McpToolError } from "./protocol";
import { attempt, denyAs, refusalOf, refused } from "./refusals";

/** The refusal code `refusalOf` gives one runner failure, or null. */
const codeOf = (error: Error): string | null =>
  refusalOf(error)?.refusal?.code ?? null;

describe("refusalOf", () => {
  test("reads the runner's 409 vocabulary into an actionable code", () => {
    const conflicts: [string, string][] = [
      [
        'tip moved under this update: refs/heads/main is Some("a"), expected b',
        "stale_tip",
      ],
      [
        "refs/heads/main is protected; commit to a new branch and open a pull request",
        "protected_branch",
      ],
      ["cannot delete the default branch", "protected_branch"],
      ["this pull request is not open", "not_open"],
      ["pull request #7 is closed and cannot be merged", "not_open"],
      ["merge conflicts: src/a.ts — resolve them locally", "not_mergeable"],
      ["needs 2 approving review(s); 1 counted", "not_mergeable"],
      ['head branch "feature" is gone', "not_mergeable"],
      ['branch "feature" already exists', "branch_exists"],
      ["something else entirely", "conflict"],
    ];

    for (const [message, code] of conflicts) {
      expect(
        codeOf(
          new RunnerHttpError(
            "POST /v1/apps/x/pull_requests/1/merge",
            409,
            message
          )
        ),
        message
      ).toBe(code);
    }
  });

  test("separates a missing branch from a missing row", () => {
    expect(
      codeOf(
        new RunnerHttpError(
          "DELETE /v1/apps/x/git/branches/x",
          404,
          'branch "x" not found'
        )
      )
    ).toBe("branch_missing");
    expect(
      codeOf(
        new RunnerHttpError(
          "GET /v1/apps/x/pull_requests/9",
          404,
          "pull request #9 not found"
        )
      )
    ).toBe("not_found");
  });

  test("a rejected argument is `invalid`, not a conflict", () => {
    expect(
      codeOf(
        new RunnerHttpError(
          "POST /v1/apps/x/source/commit",
          400,
          'invalid branch "a..b"'
        )
      )
    ).toBe("invalid");
  });

  test("an HTTP 400/403/404 is a refusal; a 500 is not", () => {
    expect(codeOf(new RunnerHttpError("GET /v1/apps/x", 403, ""))).toBe(
      "forbidden"
    );
    expect(codeOf(new RunnerHttpError("GET /v1/apps/x", 404, ""))).toBe(
      "not_found"
    );
    expect(
      codeOf(new RunnerHttpError("POST /v1/apps/x/source/commit", 400, ""))
    ).toBe("invalid");
    expect(codeOf(new RunnerHttpError("GET /v1/apps/x", 500, ""))).toBeNull();
  });

  test("a non-runner failure is not a refusal", () => {
    expect(codeOf(new Error("boom"))).toBeNull();
  });

  test("a tool's own refusal keeps its code and hint", () => {
    const error = refused("no_deploy", "nothing deployed yet");
    const classified = refusalOf(error);

    expect(classified).toBe(error);
    expect(classified?.refusal).toEqual({
      code: "no_deploy",
      hint: expect.stringContaining("deploy_status"),
      message: "nothing deployed yet",
    });
  });

  test("every refusal carries a hint the caller can act on", () => {
    for (const code of [
      "branch_exists",
      "branch_missing",
      "conflict",
      "forbidden",
      "invalid",
      "no_deploy",
      "not_found",
      "not_mergeable",
      "not_open",
      "protected_branch",
      "stale_tip",
    ] as const) {
      expect(refused(code, "m").refusal?.hint.length, code).toBeGreaterThan(10);
    }
  });
});

/** The value a rejected promise carried: the tests assert on the refusal it
 * turned into, so they need the error object rather than a rethrow. */
const rejectionOf = async (work: () => Promise<void>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("expected the call to be refused");
};

describe("denyAs and attempt", () => {
  test("a gate's bare denial gets the code the tool asked for", async () => {
    const denied = await rejectionOf(() =>
      denyAs(
        () =>
          Promise.reject(new McpToolError('No app "x" this key can push to')),
        "forbidden"
      )
    );

    expect(denied).toBeInstanceOf(McpToolError);

    if (!(denied instanceof McpToolError)) {
      throw new TypeError("expected a tool error");
    }

    expect(denied.refusal).toEqual({
      code: "forbidden",
      hint: expect.any(String),
      message: 'No app "x" this key can push to',
    });
  });

  test("an argument error (invalid) is never recoded as a refusal", async () => {
    const invalid = new McpToolError("needs a file", { invalid: true });

    const caught = await rejectionOf(() =>
      denyAs(() => Promise.reject(invalid), "forbidden")
    );

    expect(caught).toBe(invalid);
  });

  test("attempt turns a runner refusal into a refusal and leaves the rest", async () => {
    const refusal = await rejectionOf(() =>
      attempt(() =>
        Promise.reject(
          new RunnerHttpError(
            "POST /v1/apps/x/pull_requests/1/merge",
            409,
            "this pull request is not open"
          )
        )
      )
    );

    expect(refusal).toBeInstanceOf(McpToolError);

    if (!(refusal instanceof McpToolError)) {
      throw new TypeError("expected a tool error");
    }

    expect(refusal.refusal?.code).toBe("not_open");

    const plain = new Error("network is down");

    const thrown = await rejectionOf(() =>
      attempt(() => Promise.reject(plain))
    );

    expect(thrown).toBe(plain);
  });
});
