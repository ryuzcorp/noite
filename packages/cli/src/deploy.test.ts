import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { deployUrlOf, remoteUrlOf, stageDist } from "./deploy.js";

/** A dist tree with the entries a `*` glob drops: top-level dotfiles and a
 * dotdir (ACME `/.well-known/`, dotfiles like `/.headers`). */
const seedDist = async (dist: string): Promise<void> => {
  await writeFile(path.join(dist, "visible.js"), "console.log(1);\n");
  await writeFile(path.join(dist, ".dotfile"), "dot\n");
  await mkdir(path.join(dist, ".well-known"), { recursive: true });
  await writeFile(path.join(dist, ".well-known", "security.txt"), "x\n");
};

describe("deployUrlOf", () => {
  test("tenants serve at {slug}.{base}, scheme and port from the git base", () => {
    expect(deployUrlOf("https://git.noite.now", "my-app")).toBe(
      "https://my-app.noite.now"
    );
    expect(deployUrlOf("http://git.noite.localhost:9080", "my-app")).toBe(
      "http://my-app.noite.localhost:9080"
    );
    expect(deployUrlOf("https://git.example.com:8443", "shop")).toBe(
      "https://shop.example.com:8443"
    );
  });

  test("a base without the git. prefix still gets the slug subdomain", () => {
    expect(deployUrlOf("https://example.com", "shop")).toBe(
      "https://shop.example.com"
    );
    expect(deployUrlOf("https://git.example.com/", "shop")).toBe(
      "https://shop.example.com"
    );
  });

  test("a trailing-dot FQDN will not mint a double-dot host", () => {
    expect(deployUrlOf("https://git.example.com.", "shop")).toBe(
      "https://shop.example.com"
    );
  });

  test("a malformed git base is null, not a garbage URL", () => {
    expect(deployUrlOf("not a url", "shop")).toBeNull();
  });
});

describe("remoteUrlOf", () => {
  test("Basic git + token against the base host", () => {
    expect(remoteUrlOf("https://git.noite.now", "my-app", "key")).toBe(
      "https://git:key@git.noite.now/my-app"
    );
  });

  test("a base path survives (the lane serves git under /v1/git)", () => {
    expect(remoteUrlOf("http://localhost:8080/v1/git", "my-app", "key")).toBe(
      "http://git:key@localhost:8080/v1/git/my-app"
    );
    expect(remoteUrlOf("http://localhost:8080/v1/git/", "my-app", "key")).toBe(
      "http://git:key@localhost:8080/v1/git/my-app"
    );
  });

  test("a malformed git base is null, not a garbage URL", () => {
    expect(remoteUrlOf("not a url", "shop", "key")).toBeNull();
  });
});

describe("stageDist", () => {
  test("stages dotfiles and dotdirs alongside visible entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "noite-stage-"));
    try {
      const dist = path.join(root, "dist");
      const staging = path.join(root, "staging");
      await mkdir(dist, { recursive: true });
      await mkdir(staging, { recursive: true });
      await seedDist(dist);
      const wrangler = path.join(root, "wrangler.jsonc");
      await writeFile(wrangler, "{}\n");
      await Effect.runPromise(stageDist(dist, staging, wrangler));
      expect(existsSync(path.join(staging, "visible.js"))).toBe(true);
      expect(existsSync(path.join(staging, ".dotfile"))).toBe(true);
      expect(
        existsSync(path.join(staging, ".well-known", "security.txt"))
      ).toBe(true);
      expect(existsSync(path.join(staging, "wrangler.jsonc"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
