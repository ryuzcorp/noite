#!/usr/bin/env bun
/**
 * Release-notes guard for CHANGELOG.md.
 *
 * Every release section (`## [x.y.z] - date`) carries an `### Operator action
 * required` subsection, even when it only says "None": an operator upgrading
 * reads that first, so a release that forgot it must fail here, not in prod.
 *
 *   bun docker/check-changelog.ts            every released section is well formed
 *   bun docker/check-changelog.ts 0.1.0-alpha.1
 *                                            ...and that version has a dated section
 *
 * `images.yml` runs the second form on a `v*` tag before anything is pushed.
 */
import { readFileSync } from "node:fs";

const changelog = readFileSync(
  new URL("../CHANGELOG.md", import.meta.url),
  "utf-8"
);

const SECTION = /^## \[(?<name>[^\]]+)\](?: - (?<date>\S+))?\s*$/gmu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ACTION = /^### Operator action required\s*$/mu;

const marks = [...changelog.matchAll(SECTION)];
const sections = marks.map((mark, index) => ({
  body: changelog.slice(
    (mark.index ?? 0) + mark[0].length,
    marks[index + 1]?.index ?? changelog.length
  ),
  date: mark.groups?.date,
  name: mark.groups?.name ?? "",
}));

let failed = false;
const fail = (message: string): void => {
  console.error(message);
  failed = true;
};

for (const { body, date, name } of sections) {
  if (name === "Unreleased") {
    continue;
  }
  if (!(date && DATE.test(date))) {
    fail(`CHANGELOG.md: [${name}] needs a date (## [${name}] - YYYY-MM-DD)`);
  }
  if (!ACTION.test(body)) {
    fail(
      `CHANGELOG.md: [${name}] has no "### Operator action required" section`
    );
  }
}

const wanted = process.argv.slice(2).at(0);
if (wanted && !sections.some(({ name }) => name === wanted)) {
  fail(
    `CHANGELOG.md has no [${wanted}] section: move the Unreleased notes under it before tagging`
  );
}

if (failed) {
  process.exit(1);
}
console.log(
  `changelog: ${sections.length} section(s) ok${wanted ? `, ${wanted} present` : ""}`
);
