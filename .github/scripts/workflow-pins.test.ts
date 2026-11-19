/**
 * Every action pinned by commit must name the full 40-hex SHA. A truncated
 * or mangled SHA is not a pin GitHub can resolve: the job fails at setup
 * ("unable to find version"), which on 2026-11-19 broke the upgrade lane
 * after an edit corrupted three SHAs in `upgrade.yml`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOWS = path.resolve(import.meta.dir, "../workflows");

describe("workflow action pins", () => {
  test("every hex ref is a full 40-character commit SHA", () => {
    const bad: string[] = [];

    for (const file of readdirSync(WORKFLOWS).filter((name) =>
      /\.ya?ml$/u.test(name)
    )) {
      const lines = readFileSync(path.join(WORKFLOWS, file), "utf-8").split(
        "\n"
      );

      for (const [index, line] of lines.entries()) {
        const ref = /^\s*-?\s*uses:\s*[^\s@]+@(?<ref>[0-9a-f]+)\b/u.exec(line)
          ?.groups?.ref;

        if (ref !== undefined && ref.length !== 40) {
          bad.push(`${file}:${index + 1}: ${ref} (${ref.length} hex)`);
        }
      }
    }

    expect(bad).toEqual([]);
  });
});
