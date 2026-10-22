#!/usr/bin/env bun
/**
 * Assemble `changelog.d/*.md` fragments into a dated CHANGELOG section.
 *
 * The release PR runs this, then commits the result (the fragments are
 * deleted): sections land in canonical order with `### Operator action
 * required` first and always present (`- None.` when no fragment has one),
 * bullets keep their exact text in fragment file-name order.
 *
 * The new section header starts with `## [<version>]`, so the images.yml
 * prerelease-notes awk (`index($0, head)`) keeps matching unchanged.
 *
 *   bun docker/changelog-release.ts <version> [YYYY-MM-DD] [--dry-run]
 *
 * `--dry-run` prints the new CHANGELOG to stdout without writing or
 * deleting anything (used to prove the cutover lost no lines).
 */
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { spliceRelease } from "./changelog-lib";

const root = new URL("../", import.meta.url).pathname;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => !arg.startsWith("--"));

const [version, dateArg] = positional;

if (!version) {
  console.error(
    "usage: bun docker/changelog-release.ts <version> [YYYY-MM-DD] [--dry-run]"
  );
  process.exit(1);
}

const date = dateArg ?? new Date().toISOString().slice(0, 10);

const dir = path.join(root, "changelog.d");

const entries = readdirSync(dir)
  .filter((name) => name.endsWith(".md"))
  .toSorted();

const changelogPath = path.join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf-8");

let next: string;

try {
  next = spliceRelease(
    changelog,
    version,
    date,
    entries.map((name) => ({
      name,
      text: readFileSync(path.join(dir, name), "utf-8"),
    }))
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (dryRun) {
  process.stdout.write(next);
} else {
  writeFileSync(changelogPath, next);

  for (const name of entries) {
    unlinkSync(path.join(dir, name));
  }

  console.log(
    `changelog: released [${version}] from ${entries.length} fragment(s): ${entries.join(", ")}`
  );
}
