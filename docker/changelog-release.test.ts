import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { spliceRelease } from "./changelog-lib";

const BASE = `# Changelog

Intro prose.

## [Unreleased]

<!-- Release notes live in changelog.d/ -->

## [0.1.0-alpha.8] - 2026-10-21

### Operator action required

- None.
`;

describe("spliceRelease", () => {
  test("inserts the new dated section right after Unreleased, before older releases", () => {
    const out = spliceRelease(BASE, "0.1.0-alpha.9", "2026-10-22", [
      {
        name: "a.md",
        text: "### Added\n\n- A thing.\n",
      },
    ]);

    const unreleased = out.indexOf("## [Unreleased]");
    const added = out.indexOf("## [0.1.0-alpha.9] - 2026-10-22");
    const older = out.indexOf("## [0.1.0-alpha.8]");
    expect(unreleased).toBeGreaterThanOrEqual(0);
    expect(added).toBeGreaterThan(unreleased);
    expect(older).toBeGreaterThan(added);
    expect(out).toContain("- A thing.");
    expect(out).toContain("### Operator action required\n\n- None.");
  });

  test("refuses a missing Unreleased section", () => {
    expect(() =>
      spliceRelease("# No sections here.\n", "0.1.0-alpha.9", "2026-10-22", [])
    ).toThrow("Unreleased");
  });

  test("releases notes pending in Unreleased with no fragments", () => {
    const dirty = BASE.replace(
      "<!-- Release notes live in changelog.d/ -->",
      "<!-- Release notes live in changelog.d/ -->\n\n### Added\n\n- Stray.\n"
    );

    const out = spliceRelease(dirty, "0.1.0-alpha.9", "2026-10-22", []);
    expect(out).toContain("## [0.1.0-alpha.9] - 2026-10-22");
    expect(out).toContain("- Stray.");
    expect(out).not.toContain("### Added\n\n- Stray.\n\n## [0.1.0-alpha.9]");
  });

  test("refuses when fragments and Unreleased are both empty", () => {
    expect(() =>
      spliceRelease(BASE, "0.1.0-alpha.9", "2026-10-22", [])
    ).toThrow("nothing to release");
  });

  test("refuses a bad version or date", () => {
    expect(() =>
      spliceRelease(BASE, "not-a-version", "2026-10-22", [
        { name: "a.md", text: "### Added\n\n- X.\n" },
      ])
    ).toThrow("version");
    expect(() =>
      spliceRelease(BASE, "0.1.0-alpha.9", "22-10-2026", [
        { name: "a.md", text: "### Added\n\n- X.\n" },
      ])
    ).toThrow("date");
  });
});

/** Run a copy of the release script against a scratch repo root: the
 * script resolves CHANGELOG.md and changelog.d/ next to its own directory. */
const runRelease = (prepare: (root: string) => void) => {
  const root = mkdtempSync(path.join(tmpdir(), "changelog-release-"));

  try {
    mkdirSync(path.join(root, "docker"));

    for (const file of ["changelog-release.ts", "changelog-lib.ts"]) {
      copyFileSync(
        path.join(import.meta.dir, file),
        path.join(root, "docker", file)
      );
    }

    // Pending Unreleased notes, so a release with no fragments is valid.
    writeFileSync(
      path.join(root, "CHANGELOG.md"),
      BASE.replace(
        "<!-- Release notes live in changelog.d/ -->",
        "### Added\n\n- Pending note.\n"
      )
    );
    prepare(root);

    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(root, "docker", "changelog-release.ts"),
        "0.1.0-alpha.9",
        "2026-10-22",
        "--dry-run",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    return { exitCode: result.exitCode, stderr: result.stderr.toString() };
  } finally {
    // Give back read access so the scratch tree can be removed.
    const fragments = path.join(root, "changelog.d");

    if (existsSync(fragments)) {
      chmodSync(fragments, 0o700);
    }

    rmSync(root, { force: true, recursive: true });
  }
};

describe("changelog-release.ts fragment directory", () => {
  test("a missing changelog.d releases the Unreleased notes alone", () => {
    const { exitCode } = runRelease(() => {});
    expect(exitCode).toBe(0);
  });

  // Root reads through any mode, so the unreadable case only means
  // something for an unprivileged user (CI and dev boxes).
  test.skipIf(process.getuid?.() === 0)(
    "an unreadable changelog.d stops the release instead of dropping its fragments",
    () => {
      const { exitCode, stderr } = runRelease((root) => {
        const dir = path.join(root, "changelog.d");
        mkdirSync(dir);
        writeFileSync(path.join(dir, "a.md"), "### Added\n\n- A thing.\n");
        chmodSync(dir, 0o000);
      });

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("EACCES");
    }
  );
});
