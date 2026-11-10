import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import {
  advanceDeploy,
  deployUrlOf,
  DeployEvents,
  DeployPhases,
  remoteUrlOf,
  stageDist,
} from "./deploy.js";
import type { DeployPhase } from "./deploy.js";

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
  test("is a token-free remote: the key travels in git's environment", () => {
    expect(remoteUrlOf("https://git.noite.now", "my-app")).toBe(
      "https://git.noite.now/my-app"
    );
    expect(remoteUrlOf("https://git.noite.now", "my-app")).not.toContain("key");
  });

  test("a base path survives (the lane serves git under /v1/git)", () => {
    expect(remoteUrlOf("http://localhost:8080/v1/git", "my-app")).toBe(
      "http://localhost:8080/v1/git/my-app"
    );
    expect(remoteUrlOf("http://localhost:8080/v1/git/", "my-app")).toBe(
      "http://localhost:8080/v1/git/my-app"
    );
  });

  test("a malformed git base is null, not a garbage URL", () => {
    expect(remoteUrlOf("not a url", "shop")).toBeNull();
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

describe("advanceDeploy", () => {
  const comment = { _tag: "Off" } as const;

  test("walks the documented phase order", () => {
    let phase: DeployPhase = DeployPhases.Prepared();
    phase = advanceDeploy(phase, DeployEvents.Staged());
    expect(phase._tag).toBe("Staged");
    phase = advanceDeploy(phase, DeployEvents.Pushed());
    expect(phase._tag).toBe("Pushed");
    phase = advanceDeploy(phase, DeployEvents.Recorded());
    expect(phase._tag).toBe("Recorded");
    phase = advanceDeploy(phase, DeployEvents.Reported({ comment }));
    expect(phase).toEqual({ _tag: "Reported", comment });
  });

  test("refuses to report before the outputs are recorded", () => {
    expect(() =>
      advanceDeploy(DeployPhases.Pushed(), DeployEvents.Reported({ comment }))
    ).toThrow("illegal deploy transition: Pushed + Reported");
  });

  test("refuses to skip or repeat a phase", () => {
    expect(() =>
      advanceDeploy(DeployPhases.Prepared(), DeployEvents.Pushed())
    ).toThrow("illegal deploy transition: Prepared + Pushed");
    expect(() =>
      advanceDeploy(DeployPhases.Staged(), DeployEvents.Staged())
    ).toThrow("illegal deploy transition: Staged + Staged");
  });
});
