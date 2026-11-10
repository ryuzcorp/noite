// The dev stack's sandbox controller bundle (`docker/dev-sandbox.sh`).
//
// The runner loads `worker.js` + `meta.json` from `VOID_SANDBOX_BUNDLE_DIR` at
// every deploy and only the release image bakes one, so `make dev` used to
// defer the build to the developer's memory: a fresh checkout failed every
// sandbox app's deploy at `celld deploy` with "sandbox controller bundle
// incomplete" until someone ran `bun run build` in `apps/void-sandbox` by
// hand. These tests run the script for real against a stand-in package (a stub
// bundler, so nothing is downloaded) and pin what `docker/dev.sh` relies on.
import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const script = path.join(root, "docker/dev-sandbox.sh");

/** A `build.ts` stand-in: copies `worker.ts` into `dist/`, plus a fixed meta.
 * The real bundler is covered by `apps/void-sandbox/build.test.ts`. */
const STUB_BUILD = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
writeFileSync("dist/worker.js", readFileSync("worker.ts", "utf-8"));
writeFileSync(
  "dist/meta.json",
  JSON.stringify({ bundleSha256: "stub", controllerProtocol: 2, void: "1.5.0" })
);
`;

interface Fixture {
  readonly dir: string;
  readonly source: string;
  readonly work: string;
  readonly bundle: string;
}

/**
 * A stand-in for `apps/void-sandbox`. Its one dependency is a `file:` path
 * (`../dep`, which resolves the same from the package and from the work-dir
 * copy), so `bun install --frozen-lockfile` has a real lockfile to honour and
 * nothing touches the network.
 */
const fixture = (): Fixture => {
  const dir = mkdtempSync(path.join(tmpdir(), "noite-dev-sandbox-"));
  const source = path.join(dir, "pkg");
  const dep = path.join(dir, "dep");
  mkdirSync(path.join(source, "src"), { recursive: true });
  mkdirSync(dep, { recursive: true });
  writeFileSync(
    path.join(dep, "package.json"),
    JSON.stringify({ name: "fixture-dep", version: "1.0.0" })
  );
  writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      dependencies: { "fixture-dep": "file:../dep" },
      name: "fixture-sandbox",
      private: true,
      type: "module",
    })
  );
  writeFileSync(
    path.join(source, "worker.ts"),
    'export const marker = "one";\n'
  );
  writeFileSync(
    path.join(source, "src", "controller.ts"),
    "export const protocol = 2;\n"
  );
  writeFileSync(path.join(source, "build.ts"), STUB_BUILD);

  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: source,
  });

  if (install.exitCode !== 0) {
    throw new Error(`fixture bun install failed: ${install.stderr.toString()}`);
  }

  return {
    bundle: path.join(dir, "bundle"),
    dir,
    source,
    work: path.join(dir, "work"),
  };
};

const runOnce = (fix: Fixture) =>
  Bun.spawnSync([
    "sh",
    script,
    "--source",
    fix.source,
    "--work",
    fix.work,
    "--bundle",
    fix.bundle,
    "--once",
  ]);

/** Overwrite a fixture source atomically, so a watching build never reads a
 * half-written file. */
const edit = (file: string, text: string): void => {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
};

/** Reads a child's stdout until `needle` appears, consuming each match:
 * asking for the same text twice waits for a second occurrence (a new build,
 * not the first one still in the buffer). Recursive rather than looping
 * because each chunk is awaited in turn. */
const stdoutTail = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let consumed = 0;

  const drain = async (needle: string): Promise<void> => {
    const at = buffer.indexOf(needle, consumed);

    if (at !== -1) {
      consumed = at + needle.length;

      return;
    }

    const { done, value } = await reader.read();

    if (done) {
      throw new Error(`"${needle}" never appeared; output was:\n${buffer}`);
    }

    buffer += decoder.decode(value, { stream: true });

    return drain(needle);
  };

  return drain;
};

describe("dev-sandbox.sh", () => {
  test("--once publishes a bundle through a symlink it owns", () => {
    const fix = fixture();

    try {
      const result = runOnce(fix);
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(
        "published the controller bundle"
      );

      expect(lstatSync(fix.bundle).isSymbolicLink()).toBe(true);
      expect(readFileSync(path.join(fix.bundle, "worker.js"), "utf-8")).toBe(
        'export const marker = "one";\n'
      );
      expect(
        JSON.parse(readFileSync(path.join(fix.bundle, "meta.json"), "utf-8"))
      ).toEqual({
        bundleSha256: "stub",
        controllerProtocol: 2,
        void: "1.5.0",
      });
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--once keeps the bundle when the sources did not move", () => {
    const fix = fixture();

    try {
      expect(runOnce(fix).exitCode).toBe(0);
      const published = readlinkSync(fix.bundle);

      const again = runOnce(fix);
      expect(again.exitCode).toBe(0);
      expect(again.stdout.toString()).toContain("controller bundle current");
      expect(readlinkSync(fix.bundle)).toBe(published);
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--once rebuilds and republishes when a source changes", () => {
    const fix = fixture();

    try {
      expect(runOnce(fix).exitCode).toBe(0);
      const published = readlinkSync(fix.bundle);

      edit(
        path.join(fix.source, "worker.ts"),
        'export const marker = "two";\n'
      );

      const rebuilt = runOnce(fix);
      expect(rebuilt.exitCode).toBe(0);
      expect(rebuilt.stdout.toString()).toContain(
        "published the controller bundle"
      );
      const next = readlinkSync(fix.bundle);
      expect(next).not.toBe(published);
      expect(readFileSync(path.join(fix.bundle, "worker.js"), "utf-8")).toBe(
        'export const marker = "two";\n'
      );
      // Only the generation the bundle points at survives.
      expect(readdirSync(path.join(fix.work, "gens"))).toEqual([
        path.basename(next),
      ]);
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--watch rebuilds a source change made during the session", async () => {
    const fix = fixture();

    const child = Bun.spawn(
      [
        "sh",
        script,
        "--source",
        fix.source,
        "--work",
        fix.work,
        "--bundle",
        fix.bundle,
        "--watch",
        // No pause between checks: the test waits on the child's output, not
        // on the clock.
        "--poll",
        "0",
      ],
      { stderr: "inherit", stdout: "pipe" }
    );

    const awaitOutput = stdoutTail(child.stdout);

    try {
      await awaitOutput("published the controller bundle");
      expect(readFileSync(path.join(fix.bundle, "worker.js"), "utf-8")).toBe(
        'export const marker = "one";\n'
      );

      edit(
        path.join(fix.source, "worker.ts"),
        'export const marker = "two";\n'
      );

      await awaitOutput("sources changed");
      await awaitOutput("published the controller bundle");
      expect(readFileSync(path.join(fix.bundle, "worker.js"), "utf-8")).toBe(
        'export const marker = "two";\n'
      );
    } finally {
      child.kill();
      await child.exited;
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("a build failure exits non-zero instead of publishing", () => {
    const fix = fixture();

    try {
      edit(path.join(fix.source, "build.ts"), "process.exit(1);\n");
      const failed = runOnce(fix);
      expect(failed.exitCode).not.toBe(0);
      expect(lstatSync(fix.bundle, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });
});

describe("the dev stack wires the build in", () => {
  const compose = readFileSync(
    path.join(root, "docker/compose.dev.yaml"),
    "utf-8"
  );

  const dev = readFileSync(path.join(root, "docker/dev.sh"), "utf-8");

  test("dev.sh publishes into the bundle dir the dev overlay configures", () => {
    const configured = /VOID_SANDBOX_BUNDLE_DIR:\s*(?<dir>\S+)/u.exec(compose)
      ?.groups?.dir;

    const published = /^SANDBOX_BUNDLE=(?<dir>\S+)$/mu.exec(dev)?.groups?.dir;

    // The regression this pins: the overlay pointed the runner at a path
    // nothing in the dev stack built.
    expect(published).toBe("/opt/noite/void-sandbox");
    expect(configured).toBe(published);
  });

  test("the package is mounted read-only and the builder script with it", () => {
    expect(compose).toContain(
      "../apps/void-sandbox:/opt/noite/void-sandbox-src:ro,z"
    );
    expect(compose).toContain(
      "../docker/dev-sandbox.sh:/opt/noite/dev-sandbox.sh:ro,z"
    );
  });

  test("dev.sh builds before the runner starts, then keeps it current", () => {
    const once = dev.indexOf("sandbox_build --once");
    const watch = dev.indexOf("sandbox_build --watch &");
    const runner = dev.indexOf("cargo watch -q");

    expect(once).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(once);
    // The bundle must exist before anything can deploy.
    expect(once).toBeLessThan(runner);
  });
});
