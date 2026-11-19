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

/**
 * Split the `uses:` line into its full ref token, then judge the whole
 * token: a ref that is all (or starts with a full run of) lowercase hex is
 * a SHA pin attempt and must be exactly 40 hex characters. Anything else
 * (`stable`, `v2`) is a tag or branch and stays allowed. Matching only the
 * hex prefix (`[0-9a-f]+\b`) once accepted `<40 hex>-broken`: `\b` fires
 * between the fortieth hex digit and the `-`, so the mangled pin read as a
 * valid 40.
 */
const parseRef = (line: string): string | undefined =>
  /^\s*-?\s*uses:\s*[^\s@]+@(?<ref>[^\s#]+)/u.exec(line)?.groups?.ref;

const isBadRef = (ref: string): boolean =>
  (/^[0-9a-f]+$/u.test(ref) && ref.length !== 40) ||
  /^[0-9a-f]{40}[^0-9a-f]/u.test(ref);

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
        const ref = parseRef(line);

        if (ref !== undefined && isBadRef(ref)) {
          bad.push(`${file}:${index + 1}: ${ref}`);
        }
      }
    }

    expect(bad).toEqual([]);
  });

  test("a full SHA with a suffix is not a valid pin", () => {
    const sha = "a".repeat(40);

    expect(parseRef(`      - uses: actions/checkout@${sha}`)).toBe(sha);
    expect(isBadRef(sha)).toBe(false);
    // The reported hole: the old prefix match read this as a valid 40.
    expect(parseRef(`      - uses: actions/checkout@${sha}-broken`)).toBe(
      `${sha}-broken`
    );
    expect(isBadRef(`${sha}-broken`)).toBe(true);
    expect(isBadRef("a".repeat(39))).toBe(true);
    expect(isBadRef("stable")).toBe(false);
    expect(isBadRef("v2")).toBe(false);
  });
});
