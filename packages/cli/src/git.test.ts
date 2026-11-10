import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import {
  clearWorkdir,
  copyTreeEntries,
  gitAuthEnv,
  pushTree,
  scrubGitConfig,
} from "./git.js";

const git = (args: readonly string[], cwd: string): void => {
  const proc = spawnSync("git", [...args], { cwd, encoding: "utf-8" });

  if (proc.status !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed: ${proc.stderr}`);
  }
};

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
      expect(existsSync(path.join(dest, "visible.js"))).toBe(true);
      expect(existsSync(path.join(dest, ".dotfile"))).toBe(true);
      expect(existsSync(path.join(dest, ".well-known", "x"))).toBe(true);
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
      expect(existsSync(path.join(workdir, ".git", "HEAD"))).toBe(true);
      expect(existsSync(path.join(workdir, "index.html"))).toBe(false);
      expect(existsSync(path.join(workdir, ".dotfile"))).toBe(false);
      expect(existsSync(path.join(workdir, ".well-known", "old.txt"))).toBe(
        false
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("gitAuthEnv", () => {
  test("carries the key in the environment, not in a URL", () => {
    const env = gitAuthEnv("secret-key");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");

    const header = String(env.GIT_CONFIG_VALUE_0);
    expect(header.startsWith("Authorization: Basic ")).toBe(true);

    const decoded = Buffer.from(header.split(" ")[2] ?? "", "base64").toString(
      "utf-8"
    );

    expect(decoded).toBe("git:secret-key");
  });
});

describe("scrubGitConfig", () => {
  test("strips URL credentials from a retained workdir's config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noite-scrub-"));

    try {
      const config = path.join(root, ".git", "config");
      await mkdir(path.join(root, ".git"), { recursive: true });
      await writeFile(
        config,
        '[remote "origin"]\n\turl = https://git:secret-key@git.noite.now/app\n'
      );
      await Effect.runPromise(scrubGitConfig(root));
      const text = await readFile(config, "utf-8");
      expect(text).not.toContain("secret-key");
      expect(text).toContain("url = https://git.noite.now/app");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("is best effort without a config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noite-scrub-"));

    try {
      await Effect.runPromise(scrubGitConfig(root));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("pushTree", () => {
  test("bootstraps, then fast-forwards, and never persists the token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noite-push-"));

    try {
      const bare = path.join(root, "remote.git");
      git(["init", "--bare", "-b", "main", bare], root);

      const firstTree = path.join(root, "tree-one");
      await mkdir(firstTree, { recursive: true });
      await writeFile(path.join(firstTree, "index.html"), "one\n");

      const token = "s3cret-token";

      const first = await Effect.runPromise(
        pushTree({
          message: "one",
          remoteUrl: bare,
          token,
          treeDir: firstTree,
        })
      );

      expect(first).toMatch(/^[\da-f]{40}$/u);

      const secondTree = path.join(root, "tree-two");
      await mkdir(secondTree, { recursive: true });
      await writeFile(path.join(secondTree, "index.html"), "two\n");

      const second = await Effect.runPromise(
        pushTree({
          message: "two",
          remoteUrl: bare,
          token,
          treeDir: secondTree,
        })
      );

      expect(second).not.toBe(first);

      // A failed fast-forward keeps its workdir for inspection; the token is
      // in the environment only, so the kept .git/config is clean.
      let kept = "";

      const failure = await Effect.runPromise(
        pushTree({
          message: "fail",
          onKeep: (dir) =>
            Effect.sync(() => {
              kept = dir;
            }),
          remoteUrl: bare,
          token,
          treeDir: path.join(root, "missing-tree"),
        }).pipe(Effect.flip)
      );

      expect(failure.message).toContain("copying");
      expect(kept).not.toBe("");
      const config = await readFile(path.join(kept, ".git", "config"), "utf-8");
      expect(config).not.toContain(token);
      await rm(kept, { force: true, recursive: true });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
