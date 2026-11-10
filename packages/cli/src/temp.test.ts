import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";

import { Effect, Exit } from "effect";

import { cleanupOf, withTempDir } from "./temp.js";

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
};

describe("cleanupOf", () => {
  test("success removes, any failure keeps", () => {
    expect(cleanupOf("/tmp/x", Exit.succeed(1))).toEqual({
      _tag: "Removed",
    });
    expect(cleanupOf("/tmp/x", Exit.fail(new Error("boom")))).toEqual({
      _tag: "Kept",
      dir: "/tmp/x",
    });
  });
});

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

  test("runs onKeep before retaining, so secrets can be scrubbed", async () => {
    let kept = "";
    const keptDirs: string[] = [];

    await Effect.runPromise(
      withTempDir(
        (dir) =>
          Effect.gen(function* probe() {
            kept = dir;
            yield* Effect.promise(() => writeFile(`${dir}/secret.txt`, "x"));

            return yield* Effect.fail(new Error("boom"));
          }),
        {
          onKeep: (dir) =>
            Effect.sync(() => {
              keptDirs.push(dir);
            }),
        }
      ).pipe(Effect.flip)
    );

    expect(keptDirs).toEqual([kept]);
    await rm(kept, { force: true, recursive: true });
  });
});
