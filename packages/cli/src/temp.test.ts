import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";

import { Effect } from "effect";

import { withTempDir } from "./temp.js";

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe("withTempDir", () => {
  test("removes the dir after success", async () => {
    let kept = "";
    await Effect.runPromise(
      withTempDir((dir) =>
        Effect.gen(function* probe() {
          kept = dir;
          yield* Effect.promise(() => writeFile(`${dir}/probe.txt`, "x"));
        })
      )
    );
    expect(kept).not.toBe("");
    expect(await exists(kept)).toBe(false);
  });

  test("keeps the dir after failure, with its contents", async () => {
    let kept = "";
    const error = await Effect.runPromise(
      withTempDir((dir) =>
        Effect.gen(function* probe() {
          kept = dir;
          yield* Effect.promise(() => writeFile(`${dir}/probe.txt`, "x"));
          return yield* Effect.fail(new Error("boom"));
        })
      ).pipe(Effect.flip)
    );
    expect(error.message).toBe("boom");
    expect(existsSync(`${kept}/probe.txt`)).toBe(true);
    await rm(kept, { force: true, recursive: true });
    expect(await exists(kept)).toBe(false);
  });
});
