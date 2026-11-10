import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import {
  commentPr,
  COMMENT_MARKER,
  readActionContext,
  writeOutputs,
} from "./gh.js";
import type { ProcResult, RunProc } from "./proc.js";

const ENV_KEYS = [
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_REF_NAME",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};

  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    // oxlint-disable-next-line typescript/no-dynamic-delete -- fixed key list above.
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];

    if (value === undefined) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- fixed key list above.
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  saved = {};
});

const proc = (code: number, stdout = "", stderr = ""): ProcResult => ({
  code,
  stderr,
  stdout,
});

/** Answer each `gh` call from the list, in order. */
const queue = (results: readonly ProcResult[]): RunProc => {
  let index = 0;

  return () => {
    const result = results[index];
    index += 1;

    return result === undefined
      ? Effect.fail(new Error("unexpected gh call"))
      : Effect.succeed(result);
  };
};

const never: RunProc = () => Effect.fail(new Error("unexpected gh call"));

const commentArgs = {
  body: "🚀 Deploy `abc123` live",
  mode: "create" as const,
  prNumber: 7,
  repo: "owner/repo",
};

describe("readActionContext", () => {
  test("is Local outside Actions", async () => {
    expect(await Effect.runPromise(readActionContext())).toEqual({
      _tag: "Local",
    });
  });

  test("reads a PR target from the event payload", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "noite-gh-"));
    const eventPath = path.join(dir, "event.json");
    await writeFile(eventPath, JSON.stringify({ pull_request: { number: 7 } }));

    try {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.GITHUB_SHA = "abc123";

      const ctx = await Effect.runPromise(readActionContext());
      expect(ctx).toEqual({
        _tag: "Actions",
        outputFile: null,
        repo: "owner/repo",
        sha: "abc123",
        target: { _tag: "PullRequest", number: 7 },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a readable payload without a PR is a branch push", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "noite-gh-"));
    const eventPath = path.join(dir, "event.json");
    await writeFile(eventPath, "{}");

    try {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;
      process.env.GITHUB_REF_NAME = "main";

      const ctx = await Effect.runPromise(readActionContext());
      expect(ctx._tag).toBe("Actions");

      if (ctx._tag === "Actions") {
        expect(ctx.target).toEqual({ _tag: "Branch", name: "main" });
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a malformed payload is Unknown, not a silent push", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "noite-gh-"));
    const eventPath = path.join(dir, "event.json");
    await writeFile(eventPath, "not json");

    try {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;

      const ctx = await Effect.runPromise(readActionContext());
      expect(ctx._tag).toBe("Actions");

      if (ctx._tag === "Actions") {
        expect(ctx.target._tag).toBe("Unknown");
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("writeOutputs", () => {
  test("no-op without an output file", async () => {
    await Effect.runPromise(
      writeOutputs({ outputFile: null, sha: "abc", url: "https://x" })
    );
  });

  test("warns instead of failing after a live deploy", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const dir = await mkdtemp(path.join(tmpdir(), "noite-out-"));

    try {
      // A directory cannot be appended to: the write fails, the effect does not.
      await Effect.runPromise(
        writeOutputs({ outputFile: dir, sha: "abc", url: "https://x" })
      );
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "writing $GITHUB_OUTPUT failed"
      );
    } finally {
      warn.mockRestore();
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("commentPr", () => {
  test("reports Off and skipped modes without calling gh", async () => {
    expect(
      await Effect.runPromise(commentPr({ ...commentArgs, mode: "off" }, never))
    ).toEqual({ _tag: "Off" });
    expect(
      await Effect.runPromise(commentPr({ ...commentArgs, repo: null }, never))
    ).toEqual({ _tag: "Skipped", why: "no-repo" });
    expect(
      await Effect.runPromise(
        commentPr({ ...commentArgs, prNumber: null }, never)
      )
    ).toEqual({ _tag: "Skipped", why: "no-pr" });
  });

  test("posts a new comment", async () => {
    const outcome = await Effect.runPromise(
      commentPr(commentArgs, queue([proc(0)]))
    );

    expect(outcome).toEqual({ _tag: "Posted" });
  });

  test("a non-zero create exit is reported and stays soft", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await Effect.runPromise(
      commentPr(commentArgs, queue([proc(1, "", "HTTP 403")]))
    );

    expect(outcome._tag).toBe("Failed");

    if (outcome._tag === "Failed") {
      expect(outcome.reason).toContain("gh comment create exited 1");
      expect(outcome.reason).toContain("HTTP 403");
    }

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("updates the marked comment when it exists", async () => {
    const listed = JSON.stringify([
      { body: `old\n\n${COMMENT_MARKER}`, id: 42 },
    ]);

    const outcome = await Effect.runPromise(
      commentPr(
        { ...commentArgs, mode: "update" },
        queue([proc(0, listed), proc(0)])
      )
    );

    expect(outcome).toEqual({ _tag: "Updated", id: 42 });
  });

  test("creates when the marker is absent", async () => {
    const outcome = await Effect.runPromise(
      commentPr(
        { ...commentArgs, mode: "update" },
        queue([proc(0, "[]"), proc(0)])
      )
    );

    expect(outcome).toEqual({ _tag: "Posted" });
  });

  test("a non-zero patch exit is reported", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const listed = JSON.stringify([
      { body: `old\n\n${COMMENT_MARKER}`, id: 42 },
    ]);

    const outcome = await Effect.runPromise(
      commentPr(
        { ...commentArgs, mode: "update" },
        queue([proc(0, listed), proc(1, "", "HTTP 404")])
      )
    );

    expect(outcome._tag).toBe("Failed");

    if (outcome._tag === "Failed") {
      expect(outcome.reason).toContain("gh comment 42 update exited 1");
    }

    warn.mockRestore();
  });

  test("a non-zero list exit is reported", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await Effect.runPromise(
      commentPr(
        { ...commentArgs, mode: "update" },
        queue([proc(1, "", "auth required")])
      )
    );

    expect(outcome._tag).toBe("Failed");

    if (outcome._tag === "Failed") {
      expect(outcome.reason).toContain("gh listing PR comments exited 1");
    }

    warn.mockRestore();
  });
});
