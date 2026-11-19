/**
 * Shared changelog logic for `check-changelog.ts` (the gate) and
 * `changelog-release.ts` (the release assembler).
 *
 * Since the 0.2.0 beta reset the pending release notes live directly in
 * `## [Unreleased]` (the reset entry was folded there and the `changelog.d/`
 * fragments deleted). New fragments in `changelog.d/<unique-topic>.md`
 * still validate when present and release alongside the Unreleased notes.
 * The body uses the CHANGELOG's own `### <Section>` headings with
 * `- ` bullets; multi-line bullets keep their continuation lines verbatim.
 */

export const OPERATOR_SECTION = "Operator action required";

/** Section names CHANGELOG.md actually uses; fragments may use only these. */
export const KNOWN_SECTIONS: readonly string[] = [
  OPERATOR_SECTION,
  "Added",
  "Changed",
  "Removed",
  "Fixed",
  "Security",
];

/** Assembly order: operator action first, then Keep-a-Changelog order. */
export const CANONICAL_ORDER: readonly string[] = [...KNOWN_SECTIONS];

export interface FragmentInput {
  name: string;
  text: string;
}

export interface ParsedSection {
  bullets: string[];
  title: string;
}

export interface ParsedFragment {
  name: string;
  sections: ParsedSection[];
}

const HEADING = /^###\s+(?<title>.+?)\s*$/u;
const SUB_SECTION = /^##(?!#)/u;
const BULLET = /^- /u;
const COMMENT = /^\s*<!--[\s\S]*?-->\s*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RELEASE_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const OPERATOR_HEADING = /^### Operator action required\s*$/mu;
const RELEASE_HEADER = /^## \[/mu;
const SECTION_HEADER = /^## \[(?<name>[^\]]+)\](?: - (?<date>\S+))?\s*$/gmu;
const COMMENT_BLOCK = /<!--[\s\S]*?-->/gu;

const fail = (name: string, message: string): never => {
  throw new Error(`fragment "${name}": ${message}`);
};

/**
 * Parse one fragment body into sections with verbatim bullets (continuation
 * lines kept). Throws on anything that would not assemble cleanly.
 */
export const parseFragment = (name: string, text: string): ParsedFragment => {
  const sections: ParsedSection[] = [];
  let openBullet: string[] | null = null;

  const closeBullet = (): void => {
    if (openBullet) {
      sections.at(-1)?.bullets.push(openBullet.join("\n"));
      openBullet = null;
    }
  };

  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      closeBullet();
      continue;
    }

    const heading = HEADING.exec(line);

    if (heading) {
      closeBullet();
      const title = heading.groups?.title ?? "";

      if (!KNOWN_SECTIONS.includes(title)) {
        throw new Error(
          `fragment "${name}": unknown section "${title}" (allowed: ${KNOWN_SECTIONS.join(", ")})`
        );
      }

      sections.push({ bullets: [], title });
      continue;
    }

    if (SUB_SECTION.test(line)) {
      throw new Error(
        `fragment "${name}": must not contain "##" headings, only "###" sections`
      );
    }

    if (BULLET.test(line)) {
      closeBullet();

      if (sections.length === 0) {
        fail(name, "bullet before any ### section");
      }

      openBullet = [line.replace(BULLET, "")];
      continue;
    }

    if (COMMENT.test(line) && !openBullet) {
      continue;
    }

    if (openBullet) {
      openBullet.push(line);
      continue;
    }

    fail(name, `text outside a bullet: "${line.trim()}"`);
  }

  closeBullet();

  if (sections.length === 0) {
    if (text.trim() === "") {
      fail(name, "is empty");
    }

    fail(name, "has no ### sections");
  }

  for (const section of sections) {
    if (section.bullets.length === 0) {
      fail(name, `section "${section.title}" has no bullets`);
    }
  }

  return { name, sections };
};

interface ChangelogSection {
  body: string;
  date: string | undefined;
  name: string;
}

const splitSections = (changelog: string): ChangelogSection[] => {
  const marks = [...changelog.matchAll(SECTION_HEADER)];

  return marks.map((mark, index) => ({
    body: changelog.slice(
      (mark.index ?? 0) + mark[0].length,
      marks[index + 1]?.index ?? changelog.length
    ),
    date: mark.groups?.date,
    name: mark.groups?.name ?? "",
  }));
};

/**
 * Validate the changelog plus fragments. Returns human-readable errors;
 * empty means everything passes. Pure (takes text), so tests pin it.
 */
export const checkChangelog = (
  changelog: string,
  fragments: readonly FragmentInput[]
): string[] => {
  const errors: string[] = [];

  for (const { body, date, name } of splitSections(changelog)) {
    if (name === "Unreleased") {
      continue;
    }

    if (!(date && RELEASE_DATE.test(date))) {
      errors.push(
        `CHANGELOG.md: [${name}] needs a date (## [${name}] - YYYY-MM-DD)`
      );
    }

    if (!OPERATOR_HEADING.test(body)) {
      errors.push(
        `CHANGELOG.md: [${name}] has no "### Operator action required" section`
      );
    }
  }

  const unreleased = splitSections(changelog).find(
    (section) => section.name === "Unreleased"
  );

  if (unreleased) {
    const pending = unreleased.body.replaceAll(COMMENT_BLOCK, "").trim();

    if (pending !== "") {
      try {
        parseFragment("CHANGELOG.md [Unreleased]", pending);
      } catch (error) {
        errors.push(
          `CHANGELOG.md [Unreleased]: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } else {
    errors.push(
      "CHANGELOG.md: needs a ## [Unreleased] section; pending release notes live there directly"
    );
  }

  for (const { name, text } of fragments) {
    try {
      parseFragment(name, text);
    } catch (error) {
      errors.push(
        `changelog.d/${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return errors;
};

/**
 * Assemble the release section for `<version>`: sections in canonical
 * order, operator action first and always present, bullets verbatim in
 * fragment file-name order. The header starts with `## [<version>]` so the
 * images.yml prerelease-notes awk keeps matching.
 */
export const buildReleaseSection = (
  version: string,
  date: string,
  parsed: readonly ParsedFragment[]
): string => {
  if (!VERSION.test(version)) {
    throw new Error(`bad version "${version}" (want X.Y.Z[-prerelease])`);
  }

  if (!DATE.test(date)) {
    throw new Error(`bad date "${date}" (want YYYY-MM-DD)`);
  }

  const ordered = parsed.toSorted((a, b) => {
    if (a.name === b.name) {
      return 0;
    }

    return a.name < b.name ? -1 : 1;
  });

  const lines = [`## [${version}] - ${date}`, ""];

  for (const title of CANONICAL_ORDER) {
    const bullets = ordered.flatMap((fragment) =>
      fragment.sections
        .filter((section) => section.title === title)
        .flatMap((section) => section.bullets)
    );

    if (title !== OPERATOR_SECTION && bullets.length === 0) {
      continue;
    }

    lines.push(
      `### ${title}`,
      "",
      ...(bullets.length > 0 ? bullets.map((b) => `- ${b}`) : ["- None."]),
      ""
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

/** Pointer left in an emptied `## [Unreleased]` so editors find where pending notes live. */
export const UNRELEASED_POINTER =
  "<!-- Pending release notes live in ## [Unreleased] directly; new notes go in changelog.d/<topic>.md and the release PR assembles both with `bun docker/changelog-release.ts`. -->";

const UNRELEASED_HEADER = /^## \[Unreleased\]\s*$/mu;

/**
 * Splice the assembled section into the changelog right after the
 * `## [Unreleased]` block. Notes pending in Unreleased release alongside
 * `changelog.d/` fragments (name sorts with them); the block is emptied
 * back to the pointer. Throws when there is nothing to release, or the
 * version/date is bad.
 */
export const spliceRelease = (
  changelog: string,
  version: string,
  date: string,
  fragments: readonly FragmentInput[]
): string => {
  if (!VERSION.test(version)) {
    throw new Error(`bad version "${version}" (want X.Y.Z[-prerelease])`);
  }

  if (!DATE.test(date)) {
    throw new Error(`bad date "${date}" (want YYYY-MM-DD)`);
  }

  const header = UNRELEASED_HEADER.exec(changelog);

  if (!header || header.index === undefined) {
    throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  }

  const bodyStart = header.index + header[0].length;
  const next = RELEASE_HEADER.exec(changelog.slice(bodyStart));

  const bodyEnd =
    bodyStart + (next?.index === undefined ? changelog.length : next.index);

  const pending = changelog
    .slice(bodyStart, bodyEnd)
    .replaceAll(COMMENT_BLOCK, "")
    .trim();

  const inputs: FragmentInput[] =
    pending === ""
      ? [...fragments]
      : [...fragments, { name: "CHANGELOG.md [Unreleased]", text: pending }];

  if (inputs.length === 0) {
    throw new Error(
      "no fragments in changelog.d/ and [Unreleased] is empty; nothing to release"
    );
  }

  const parsed = inputs.map(({ name, text }) => parseFragment(name, text));
  const section = buildReleaseSection(version, date, parsed);
  const block = changelog.slice(bodyStart, bodyEnd);

  const pointer =
    pending === "" && block.includes("changelog.d/")
      ? block
      : `\n\n${UNRELEASED_POINTER}\n\n`;

  return `${changelog.slice(0, bodyStart)}${pointer}${section}\n${changelog.slice(bodyEnd)}`;
};
