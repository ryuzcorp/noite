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
  existsSync,
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

/** Every stub build records its attempt in the work dir, so a retry loop is
 * countable from the test (the work dir survives each source sync). */
const ATTEMPT = `appendFileSync("attempts.log", "attempt\\n");`;

/** A `build.ts` stand-in: copies `worker.ts` into `dist/`, plus a fixed meta.
 * The real bundler is covered by `apps/void-sandbox/build.test.ts`. */
const STUB_BUILD = `import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

${ATTEMPT}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/worker.js", readFileSync("worker.ts", "utf-8"));
writeFileSync(
  "dist/meta.json",
  JSON.stringify({ bundleSha256: "stub", controllerProtocol: 2, void: "1.5.0" })
);
`;

/** The same stand-in, failing the way a broken edit does. */
const FAILING_BUILD = `import { appendFileSync } from "node:fs";

${ATTEMPT}
process.exit(1);
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
  // The builder copies the bundler's config with the sources (Bun.build
  // honours it), so the stand-in package carries one.
  writeFileSync(path.join(source, "tsconfig.json"), "{}\n");

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

/** The script's arguments, with the paths a test wants to get wrong. */
const runArgs = (
  fix: Fixture,
  overrides: { readonly work?: string; readonly bundle?: string } = {}
) => [
  "sh",
  script,
  "--source",
  fix.source,
  "--work",
  overrides.work ?? fix.work,
  "--bundle",
  overrides.bundle ?? fix.bundle,
  "--once",
];

const runOnce = (fix: Fixture) => Bun.spawnSync(runArgs(fix));

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

/** Start `--watch` with no pause between checks: the watch tests wait on the
 * child's output, never on the clock. stderr is merged into the same pipe
 * because the failure diagnostics (the ones a dev reads in `make logs`) go
 * there. */
const startWatch = (fix: Fixture) =>
  Bun.spawn(
    [
      "sh",
      "-c",
      'exec "$0" "$@" 2>&1',
      script,
      "--source",
      fix.source,
      "--work",
      fix.work,
      "--bundle",
      fix.bundle,
      "--watch",
      "--poll",
      "0",
    ],
    { stderr: "inherit", stdout: "pipe" }
  );

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
      // The swap link is per-writer and gone once the rename lands: a fixed
      // name there would be a mutable path two publishes could both move.
      expect(
        readdirSync(path.join(fix.work, "gens")).filter((name) =>
          name.startsWith("link.")
        )
      ).toEqual([]);
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
      // The generation a deploy may have resolved before the swap survives;
      // everything older is gone.
      expect(readdirSync(path.join(fix.work, "gens")).toSorted()).toEqual(
        [path.basename(published), path.basename(next)].toSorted()
      );
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--once keeps the previous generation until the next one replaces it", () => {
    const fix = fixture();

    try {
      expect(runOnce(fix).exitCode).toBe(0);
      const first = readlinkSync(fix.bundle);

      edit(
        path.join(fix.source, "worker.ts"),
        'export const marker = "two";\n'
      );
      expect(runOnce(fix).exitCode).toBe(0);
      const second = readlinkSync(fix.bundle);

      // A deploy that resolved `first` just before the swap is still reading
      // it; deleting it here would fail that deploy with ENOENT.
      expect(existsSync(first)).toBe(true);

      edit(
        path.join(fix.source, "worker.ts"),
        'export const marker = "three";\n'
      );
      expect(runOnce(fix).exitCode).toBe(0);
      const third = readlinkSync(fix.bundle);

      expect(existsSync(second)).toBe(true);
      expect(existsSync(first)).toBe(false);
      expect(readdirSync(path.join(fix.work, "gens")).toSorted()).toEqual(
        [path.basename(second), path.basename(third)].toSorted()
      );
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--once refuses a bundle path it would have to share or overwrite", () => {
    const fix = fixture();

    try {
      // Relative paths land wherever the container's cwd is.
      for (const overrides of [
        { work: "relative-work" },
        { bundle: "relative-bundle" },
      ]) {
        const refused = Bun.spawnSync(runArgs(fix, overrides));

        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain("absolute path");
      }

      // A bundle inside the work tree: the publish renames over it and the
      // prune runs under the work dir.
      const inside = Bun.spawnSync(
        runArgs(fix, { bundle: path.join(fix.work, "bundle") })
      );

      expect(inside.exitCode).toBe(2);
      expect(inside.stderr.toString()).toContain("inside --work");

      // The filesystem root is never ours to build in or publish over.
      const atRoot = Bun.spawnSync(runArgs(fix, { bundle: "/" }));

      expect(atRoot.exitCode).toBe(2);
      expect(atRoot.stderr.toString()).toContain("not /");
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--once fails loudly when the package has no tsconfig.json", () => {
    const fix = fixture();

    try {
      rmSync(path.join(fix.source, "tsconfig.json"));

      const missing = runOnce(fix);

      expect(missing.exitCode).not.toBe(0);
      // The script's own message, not a bare `cp: cannot stat` from the copy.
      expect(missing.stderr.toString()).toContain(
        `${path.join(fix.source, "tsconfig.json")} is missing`
      );
      expect(lstatSync(fix.bundle, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--watch rebuilds a source change made during the session", async () => {
    const fix = fixture();
    const child = startWatch(fix);
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

  test("--watch does not retry a failing source until it changes", async () => {
    const fix = fixture();
    const child = startWatch(fix);
    const awaitOutput = stdoutTail(child.stdout);

    try {
      await awaitOutput("published the controller bundle");

      // A broken edit: the rebuild fails, which must not turn into a rebuild
      // of the same bytes on every poll. The stale bundle is withdrawn first,
      // then the failure is reported.
      edit(path.join(fix.source, "build.ts"), FAILING_BUILD);
      await awaitOutput("withdrew the stale controller bundle");
      await awaitOutput("sandbox controller build failed");

      edit(path.join(fix.source, "build.ts"), STUB_BUILD);
      await awaitOutput("published the controller bundle");

      // The first build, the failed one, the fixed one — a per-poll retry of
      // the failing digest would leave hundreds of attempts here.
      const log = readFileSync(path.join(fix.work, "attempts.log"), "utf-8");

      expect(log.trim().split("\n")).toHaveLength(3);
    } finally {
      child.kill();
      await child.exited;
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--once withdraws the bundle the sources no longer build", () => {
    const fix = fixture();

    try {
      expect(runOnce(fix).exitCode).toBe(0);
      expect(lstatSync(fix.bundle).isSymbolicLink()).toBe(true);

      edit(path.join(fix.source, "build.ts"), FAILING_BUILD);

      const failed = runOnce(fix);

      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr.toString()).toContain("withdrew");
      // A deploy must fail instead of running the controller from bytes the
      // sources no longer produce.
      expect(lstatSync(fix.bundle, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      rmSync(fix.dir, { force: true, recursive: true });
    }
  });

  test("--once re-installs and refuses a package.json the lockfile lacks", () => {
    const fix = fixture();

    try {
      expect(runOnce(fix).exitCode).toBe(0);
      // A dependency the lockfile does not carry: the frozen install has to
      // run and refuse, never build against the tree installed before.
      edit(
        path.join(fix.source, "package.json"),
        JSON.stringify({
          dependencies: {
            "fixture-dep": "file:../dep",
            "not-in-the-lockfile": "^1.0.0",
          },
          name: "fixture-sandbox",
          private: true,
          type: "module",
        })
      );

      const drifted = runOnce(fix);
      expect(drifted.exitCode).not.toBe(0);
      expect(drifted.stdout.toString()).toContain("bun install");
    } finally {
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

  test("dev.sh builds before the runner starts, then supervises the watcher", () => {
    const once = dev.indexOf("sandbox_build --once");
    const loop = dev.indexOf("sandbox_loop &");
    const watch = dev.indexOf("sandbox_build --watch");
    const restart = dev.indexOf("sandbox bundle watcher exited");
    const runner = dev.indexOf("cargo watch -q");

    expect(once).toBeGreaterThan(-1);
    // The bundle must exist before anything can deploy.
    expect(once).toBeLessThan(runner);
    // And the watcher is restarted if it dies, or the session ships the last
    // bundle it published without anyone noticing.
    expect(loop).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(watch);
  });
});
