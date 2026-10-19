import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { clearWorkdir, copyTreeEntries } from "./git.js";

describe("copyTreeEntries", () => {
  test("copies dotfiles and dotdirs a * glob would drop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noite-copy-"));
    try {
      const src = path.join(root, "src");
      const dest = path.join(root, "dest");
      await mkdir(src, { recursive: true });
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(src, "visible.js"), "x\n");
      await writeFile(path.join(src, ".dotfile"), "dot\n");
      await mkdir(path.join(src, ".well-known"));
      await writeFile(path.join(src, ".well-known", "x"), "y\n");
      await Effect.runPromise(copyTreeEntries(src, dest));
      expect(await Bun.file(path.join(dest, "visible.js")).exists()).toBe(true);
      expect(await Bun.file(path.join(dest, ".dotfile")).exists()).toBe(true);
      expect(await Bun.file(path.join(dest, ".well-known", "x")).exists()).toBe(
        true
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("clearWorkdir", () => {
  test("removes stale dotfiles but keeps .git for ancestry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noite-clear-"));
    try {
      const workdir = path.join(root, "work");
      await mkdir(path.join(workdir, ".git"), { recursive: true });
      await writeFile(path.join(workdir, ".git", "HEAD"), "ref: main\n");
      await writeFile(path.join(workdir, "index.html"), "old\n");
      await writeFile(path.join(workdir, ".dotfile"), "stale\n");
      await mkdir(path.join(workdir, ".well-known"));
      await writeFile(path.join(workdir, ".well-known", "old.txt"), "stale\n");
      await Effect.runPromise(clearWorkdir(workdir));
      expect(await Bun.file(path.join(workdir, ".git", "HEAD")).exists()).toBe(
        true
      );
      expect(await Bun.file(path.join(workdir, "index.html")).exists()).toBe(
        false
      );
      expect(await Bun.file(path.join(workdir, ".dotfile")).exists()).toBe(
        false
      );
      expect(
        await Bun.file(path.join(workdir, ".well-known", "old.txt")).exists()
      ).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
