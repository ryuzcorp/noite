import { describe, expect, test } from "bun:test";

import {
  CANONICAL_ORDER,
  buildReleaseSection,
  checkChangelog,
  parseFragment,
} from "./changelog-lib";

const FRAGMENT_BETA = `### Added

- **First.** Line one.
- **Second.** Multi-line bullet,
  continued here verbatim.
`;

describe("parseFragment", () => {
  test("groups bullets under their section, keeping continuation lines verbatim", () => {
    const parsed = parseFragment("beta.md", FRAGMENT_BETA);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.title).toBe("Added");
    expect(parsed.sections[0]?.bullets).toEqual([
      "**First.** Line one.",
      "**Second.** Multi-line bullet,\n  continued here verbatim.",
    ]);
  });

  test("rejects an unknown section", () => {
    expect(() =>
      parseFragment("bad.md", "### Performance\n\n- Fast.\n")
    ).toThrow('unknown section "Performance"');
  });

  test("rejects a fragment with no sections", () => {
    expect(() => parseFragment("empty.md", "- Just a bullet.\n")).toThrow(
      "bullet before any ### section"
    );
  });

  test("rejects a section with no bullets", () => {
    expect(() =>
      parseFragment("nobu.md", "### Added\n\nSome prose, no bullets.\n")
    ).toThrow("no bullets");
  });

  test("rejects an empty fragment", () => {
    expect(() => parseFragment("blank.md", "\n")).toThrow("empty");
  });
});

describe("buildReleaseSection", () => {
  test("emits sections in canonical order with operator action first", () => {
    const parsed = [
      parseFragment("b.md", "### Fixed\n\n- B fix.\n"),
      parseFragment("a.md", "### Added\n\n- A thing.\n"),
    ];

    const out = buildReleaseSection("0.1.0-alpha.9", "2026-10-22", parsed);
    const titles = [...out.matchAll(/^### (?<title>.+)$/gmu)].map((m) => m[1]);
    expect(titles).toEqual(["Operator action required", "Added", "Fixed"]);
    expect(CANONICAL_ORDER[0]).toBe("Operator action required");
  });

  test("defaults operator action to `- None.` when no fragment has one", () => {
    const out = buildReleaseSection("0.1.0-alpha.9", "2026-10-22", [
      parseFragment("a.md", "### Added\n\n- A thing.\n"),
    ]);

    expect(out).toContain("### Operator action required\n\n- None.");
  });

  test("keeps operator bullets verbatim when present", () => {
    const out = buildReleaseSection("0.1.0-alpha.9", "2026-10-22", [
      parseFragment(
        "a.md",
        "### Operator action required\n\n- **Do the thing.** Now.\n"
      ),
    ]);

    expect(out).toContain("- **Do the thing.** Now.");
    expect(out).not.toContain("- None.");
  });

  test("orders bullets by fragment file name within a section", () => {
    const out = buildReleaseSection("0.1.0-alpha.9", "2026-10-22", [
      parseFragment("z-last.md", "### Added\n\n- Zee.\n"),
      parseFragment("a-first.md", "### Added\n\n- Aye.\n"),
    ]);

    expect(out.indexOf("- Aye.")).toBeLessThan(out.indexOf("- Zee."));
  });

  test("header matches the images.yml awk prefix (`## [<version>]`)", () => {
    const out = buildReleaseSection("0.1.0-alpha.9", "2026-10-22", []);
    expect(out.startsWith("## [0.1.0-alpha.9] - 2026-10-22")).toBe(true);
  });
});

describe("checkChangelog", () => {
  const released = `# Changelog\n\n## [Unreleased]\n\n## [0.1.0-alpha.8] - 2026-10-21\n\n### Operator action required\n\n- None.\n`;

  test("passes on an empty Unreleased section with valid fragments", () => {
    expect(
      checkChangelog(released, [{ name: "a.md", text: FRAGMENT_BETA }])
    ).toEqual([]);
  });

  test("fails when Unreleased still has entries, pointing at changelog.d/", () => {
    const dirty = released.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n### Added\n\n- Forgot fragments.\n"
    );

    const errors = checkChangelog(dirty, []);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("changelog.d/");
  });

  test("fails on a fragment with an unknown section", () => {
    const errors = checkChangelog(released, [
      { name: "bad.md", text: "### Uh oh\n\n- Nope.\n" },
    ]);

    expect(errors.join("\n")).toContain('unknown section "Uh oh"');
  });
});
