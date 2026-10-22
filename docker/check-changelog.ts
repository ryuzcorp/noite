#!/usr/bin/env bun
/**
 * Release-notes guard for CHANGELOG.md and changelog.d/.
 *
 * Release sections (`## [x.y.z] - date`) each carry an `### Operator action
 * required` subsection, even when it only says "None": an operator upgrading
 * reads that first, so a release that forgot it must fail here, not in prod.
 *
 * Since fragments landed, `## [Unreleased]` stays empty: new notes go in
 * `changelog.d/<unique-topic>.md` (the CHANGELOG's own `### <Section>`
 * headings with `- ` bullets), so concurrent PRs stop conflicting on one
 * section. The release PR assembles them with
 * `bun docker/changelog-release.ts <version> [date]`.
 *
 *   bun docker/check-changelog.ts            released sections + fragments + empty Unreleased
 *   bun docker/check-changelog.ts 0.1.0-alpha.1
 *                                            ...and that version has a dated section
 *
 * `images.yml` runs the second form on a `v*` tag before anything is pushed.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { checkChangelog } from "./changelog-lib";

const root = new URL("../", import.meta.url).pathname;

const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf-8");

const dir = path.join(root, "changelog.d");
let entries: string[] = [];

try {
  entries = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .toSorted();
} catch {
  entries = [];
}

const fragments = entries.map((name) => ({
  name,
  text: readFileSync(path.join(dir, name), "utf-8"),
}));

const errors = checkChangelog(changelog, fragments);

const wanted = process.argv.slice(2).at(0);

if (wanted && !new RegExp(`^## \\[${wanted}\\]`, "mu").test(changelog)) {
  errors.push(
    `CHANGELOG.md has no [${wanted}] section: run bun docker/changelog-release.ts ${wanted} before tagging`
  );
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }

  process.exit(1);
}

console.log(
  `changelog: ${fragments.length} fragment(s) ok${wanted ? `, ${wanted} present` : ""}`
);
