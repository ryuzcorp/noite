import { describe, expect, test } from "bun:test";

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
