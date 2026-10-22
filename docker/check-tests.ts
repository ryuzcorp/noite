#!/usr/bin/env bun
/**
 * Static test-hygiene guard, run in `check.yml`: no retries anywhere, no
 * wall-clock sleeps in tests. A failure names the file and line plus the
 * rule, and explains the allowed alternative.
 *
 * Scope (fixed, no allowlist, no inline ignores — the scanner strips
 * comments and strings before matching, so neither can silence it):
 * - `apps/noite/playwright.config.ts`: a top-level or project `retries`
 *   other than 0.
 * - Playwright specs (the e2e directory): `test.describe.configure`
 *   `retries`, `test.info().retry`-based branching, and the waits
 *   `page.waitForTimeout`, `setTimeout`, `Bun.sleep`, `await sleep(`.
 * - UI unit tests (`.test.ts` and `.test.tsx` files under `apps/noite/src`):
 *   `Bun.sleep`, `await sleep(`, and `setTimeout` waits — unless the file
 *   runs under fake timers (`useFakeTimers`, or it assigns
 *   `globalThis.setTimeout`).
 * - Rust test code (`tests.rs` files, `tests/` dirs, `#[cfg(test)]`
 *   modules): `std::thread::sleep`, `tokio::time::sleep`,
 *   `tokio::time::sleep_until` — unless that test runs under paused time
 *   (`#[tokio::test(start_paused = true)]`, or `tokio::time::pause()` in
 *   the same test).
 * - A `--retries` flag in the Makefile, `docker/*.sh` or the workflows.
 *
 * The pure scanners are exported for `check-tests.test.ts`; running this
 * file executes the repo scan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type TestRule =
  | "no-retry-flag"
  | "no-test-retry"
  | "no-wall-clock-sleep";

export interface TestViolation {
  file: string;
  hint: string;
  line: number;
  rule: TestRule;
}

interface TestFn {
  attr: string;
  body: string;
  end: number;
  start: number;
}

const hintFor = (rule: TestRule): string => {
  if (rule === "no-retry-flag") {
    return "drop the flag — a flaky lane fails loudly instead";
  }

  if (rule === "no-test-retry") {
    return "remove the retry — a flaky test fails loudly instead; fix the flake at its root";
  }

  return "poll the real condition with expect.poll, await a real signal, or inject the clock";
};

const lineOf = (source: string, index: number): number => {
  let line = 1;

  for (let i = 0; i < index; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }

  return line;
};

/** Append `source[from..to]` blanked (newlines kept) to `parts`. */
const appendBlank = (
  parts: string[],
  source: string,
  from: number,
  to: number
): void => {
  for (let k = from; k < to; k += 1) {
    parts.push(source[k] === "\n" ? "\n" : " ");
  }
};

/** End of the `//…` comment opening at `at`: the newline, or the source. */
const lineCommentEnd = (source: string, at: number): number => {
  const end = source.indexOf("\n", at);

  if (end === -1) {
    return source.length;
  }

  return end;
};

/** End (exclusive) of the `/*…*\/` comment opening at `at` (TypeScript
 * block comments do not nest: the first close wins). */
const tsBlockEnd = (source: string, at: number): number => {
  const end = source.indexOf("*/", at + 2);

  if (end === -1) {
    return source.length;
  }

  return end + 2;
};

/** End (exclusive) of the quoted string opening at `at` (the quote
 * itself): honors backslash escapes, tolerates a missing close. */
const quotedEnd = (source: string, at: number): number => {
  const quote = source[at] ?? "";
  let k = at + 1;

  while (k < source.length) {
    const inner = source[k] ?? "";

    if (inner === "\\") {
      k += 2;
    } else if (inner === quote) {
      return k + 1;
    } else {
      k += 1;
    }
  }

  return k;
};

/** One template piece: literal text until the closing backtick, an
 * interpolation, or the source end. */
interface TemplateChunk {
  end: number;
  kind: "eof" | "expr" | "tick";
}

const templateChunk = (source: string, at: number): TemplateChunk => {
  let k = at;

  while (k < source.length) {
    const inner = source[k] ?? "";
    const next = source[k + 1] ?? "";

    if (inner === "\\") {
      k += 2;
    } else if (inner === "`") {
      return { end: k + 1, kind: "tick" };
    } else if (inner === "$" && next === "{") {
      return { end: k + 2, kind: "expr" };
    } else {
      k += 1;
    }
  }

  return { end: k, kind: "eof" };
};

const REGEX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Whether the slash at `at` opens a regex literal (rather than dividing).
 * A regex follows an operator, an opener, or a keyword like `return`. */
const slashStartsRegex = (source: string, at: number): boolean => {
  if (source[at + 1] === "=") {
    return false;
  }

  let j = at - 1;

  while (j >= 0 && /\s/u.test(source[j] ?? "")) {
    j -= 1;
  }

  const prev = source[j] ?? "";

  if (prev === "+" || prev === "-") {
    if (source[j - 1] === prev) {
      return false;
    }

    return true;
  }

  if ("([{,=;!&|?:~^%<>*".includes(prev)) {
    return true;
  }

  if (!/[$\w]/u.test(prev)) {
    return false;
  }

  let word = prev;
  let k = j - 1;

  while (k >= 0 && /[$\w]/u.test(source[k] ?? "")) {
    word = `${source[k] ?? ""}${word}`;
    k -= 1;
  }

  return REGEX_KEYWORDS.has(word);
};

/** End (exclusive) of the regex literal opening at `at`, or `at` when the
 * slash divides. An unterminated slash (a newline first) is a division too,
 * so a bad guess can only blank to the end of the line, never the rest of
 * the file. */
export const regexEnd = (source: string, at: number): number => {
  if (!slashStartsRegex(source, at)) {
    return at;
  }

  let k = at + 1;
  let inClass = false;

  while (k < source.length) {
    const inner = source[k] ?? "";

    if (inner === "\n") {
      return at;
    }

    if (inner === "\\") {
      k += 2;
    } else if (inClass) {
      if (inner === "]") {
        inClass = false;
      }

      k += 1;
    } else if (inner === "[") {
      inClass = true;
      k += 1;
    } else if (inner === "/") {
      k += 1;

      while (k < source.length && /[a-z]/u.test(source[k] ?? "")) {
        k += 1;
      }

      return k;
    } else {
      k += 1;
    }
  }

  return at;
};

/** Blank every comment, string literal and regex, keeping newlines so line
 * numbers survive. Template `${}` expressions stay code: hiding a wait
 * there would be a hole, not a simplification. */
export const stripTs = (source: string): string => {
  const parts: string[] = [];
  const stack: ("brace" | "tmpl")[] = [];
  let mode: "code" | "tq" = "code";
  let i = 0;

  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (mode === "tq") {
      const chunk = templateChunk(source, i);
      appendBlank(parts, source, i, chunk.end);

      if (chunk.kind === "expr") {
        stack.push("tmpl");
      }

      mode = "code";
      i = chunk.end;
    } else if (char === "/" && next === "/") {
      const end = lineCommentEnd(source, i);
      appendBlank(parts, source, i, end);
      i = end;
    } else if (char === "/" && next === "*") {
      const end = tsBlockEnd(source, i);
      appendBlank(parts, source, i, end);
      i = end;
    } else if (char === "/") {
      // A regex literal would swallow the `//`, quotes and backticks inside
      // it, while a division leaves the code readable.
      const end = regexEnd(source, i);

      if (end > i) {
        appendBlank(parts, source, i, end);
        i = end;
      } else {
        parts.push(char);
        i += 1;
      }
    } else if (char === "'" || char === '"') {
      const end = quotedEnd(source, i);
      appendBlank(parts, source, i, end);
      i = end;
    } else if (char === "`") {
      parts.push(" ");
      mode = "tq";
      i += 1;
    } else if (char === "{") {
      stack.push("brace");
      parts.push(char);
      i += 1;
    } else if (char === "}") {
      const frame = stack.pop();

      if (frame === "tmpl") {
        mode = "tq";
      }

      parts.push(char);
      i += 1;
    } else {
      parts.push(char);
      i += 1;
    }
  }

  return parts.join("");
};

/** Length of the `'…'` char literal starting at `at` (escapes included), or
 * 0 when `at` opens a lifetime or anything else. */
const charLiteralLength = (source: string, at: number): number => {
  if (source[at] !== "'") {
    return 0;
  }

  let j = at + 1;

  if (source[j] === "\\") {
    j += 1;

    if (source[j] === "u" && source[j + 1] === "{") {
      const end = source.indexOf("}", j);

      if (end === -1) {
        return 0;
      }

      j = end + 1;
    } else if (source[j] === "x") {
      j += 3;
    } else {
      j += 1;
    }
  } else if (source[j] === "\n" || source[j] === undefined) {
    return 0;
  } else {
    j += 1;
  }

  if (source[j] !== "'") {
    return 0;
  }

  return j + 1 - at;
};

/** End (exclusive) of the depth-counted `/*…*\/` comment opening at `at`
 * (Rust block comments nest). */
const rustBlockEnd = (source: string, at: number): number => {
  let depth = 0;
  let k = at;

  while (k < source.length) {
    if (source[k] === "/" && source[k + 1] === "*") {
      depth += 1;
      k += 2;
    } else if (source[k] === "*" && source[k + 1] === "/") {
      depth -= 1;
      k += 2;

      if (depth === 0) {
        return k;
      }
    } else {
      k += 1;
    }
  }

  return k;
};

/** End (exclusive) of the raw string opening at `at` (`r"…"` with any
 * number of `#`), or null when `at` does not open one. */
const rustRawEnd = (source: string, at: number): number | null => {
  let hashes = 0;

  while (source[at + 1 + hashes] === "#") {
    hashes += 1;
  }

  if (source[at + 1 + hashes] !== '"') {
    return null;
  }

  const closer = `"${"#".repeat(hashes)}`;
  const end = source.indexOf(closer, at + 1 + hashes + 1);

  if (end === -1) {
    return source.length;
  }

  return end + closer.length;
};

/** End (exclusive) of the `b"…"` / `b'…'` literal at `at`. */
const rustByteEnd = (source: string, at: number): number => {
  if (source[at + 1] === "'") {
    const literal = charLiteralLength(source, at + 1);

    if (literal > 0) {
      return at + 1 + literal;
    }

    return at + 1;
  }

  return quotedEnd(source, at + 1);
};

/** Blank every comment, string, char and byte literal (raw strings
 * included), keeping newlines. A `'` only opens a literal when a char
 * follows — lifetimes stay code. */
export const stripRust = (source: string): string => {
  const parts: string[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (char === "/" && next === "/") {
      const end = lineCommentEnd(source, i);
      appendBlank(parts, source, i, end);
      i = end;
    } else if (char === "/" && next === "*") {
      const end = rustBlockEnd(source, i);
      appendBlank(parts, source, i, end);
      i = end;
    } else if (char === "r" && (next === '"' || next === "#")) {
      const end = rustRawEnd(source, i);

      if (end === null) {
        parts.push(char);
        i += 1;
      } else {
        appendBlank(parts, source, i, end);
        i = end;
      }
    } else if (char === "b" && (next === '"' || next === "'")) {
      const end = rustByteEnd(source, i);
      appendBlank(parts, source, i, end);
      i = end;
    } else if (char === '"') {
      const end = quotedEnd(source, i);
      appendBlank(parts, source, i, end);
      i = end;
    } else if (char === "'") {
      const literal = charLiteralLength(source, i);

      if (literal > 0) {
        appendBlank(parts, source, i, i + literal);
        i += literal;
      } else {
        parts.push(char);
        i += 1;
      }
    } else {
      parts.push(char);
      i += 1;
    }
  }

  return parts.join("");
};

/** End (exclusive) of the `{…}` block opening at `open`. */
const blockEnd = (source: string, open: number): number => {
  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;

      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return source.length;
};

/** Every `#[test]` / `#[tokio::test(…)]` function in stripped source, with
 * its attribute text and body span. */
export const testFns = (stripped: string): TestFn[] => {
  const found: TestFn[] = [];

  const pattern =
    /#\[(?:test|tokio::test(?:\([^\\\]]*\))?)\][\s\S]*?fn\s+\w+\s*\([^)]*\)\s*(?:->[^{]*)?\{/gu;

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(stripped)) !== null) {
    const open = match[0].lastIndexOf("{");
    const start = match.index + open;
    const end = blockEnd(stripped, start);
    found.push({
      attr: match[0],
      body: stripped.slice(start, end),
      end,
      start,
    });
  }

  return found;
};

/** Spans of inline `#[cfg(test)] mod … {…}` modules in stripped source. */
export const cfgTestSpans = (
  stripped: string
): { end: number; start: number }[] => {
  const spans: { end: number; start: number }[] = [];
  const pattern = /#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*\{/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(stripped)) !== null) {
    const open = match[0].lastIndexOf("{");
    const start = match.index + open;
    spans.push({ end: blockEnd(stripped, start), start });
  }

  return spans;
};

/** Modules gated at their declaration (`#[cfg(test)] mod foo;` in a crate
 * root): the whole `foo.rs` file is test code. */
export const cfgTestFiles = (rootSource: string): Set<string> => {
  const names = new Set<string>();
  const pattern = /#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+(?<name>\w+)\s*;/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rootSource)) !== null) {
    names.add(`${match.groups?.name ?? ""}.rs`);
  }

  return names;
};

interface SleepPattern {
  hint: string;
  pattern: RegExp;
}

const TS_SLEEPS: SleepPattern[] = [
  {
    hint: "poll the real condition with expect.poll, await a real signal, or inject the clock",
    pattern: /\bwaitForTimeout\s*\(/u,
  },
  {
    hint: "inject the clock (hand-fired timers), await a real signal, or use AbortSignal.timeout for a pure deadline",
    pattern: /\bsetTimeout\s*\(/u,
  },
  {
    hint: "inject the clock (hand-fired timers) or await a real signal instead",
    pattern: /\bBun\s*\.\s*sleep\b/u,
  },
  {
    hint: "poll the real condition with expect.poll (e2e) or use an injected clock / fake timers (unit tests)",
    pattern: /\bawait\s+sleep\s*\(/u,
  },
];

const scanPatterns = (
  file: string,
  stripped: string,
  patterns: SleepPattern[],
  rule: TestRule
): TestViolation[] => {
  const violations: TestViolation[] = [];

  for (const { hint, pattern } of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    let match: RegExpExecArray | null;

    while ((match = global.exec(stripped)) !== null) {
      violations.push({
        file,
        hint,
        line: lineOf(stripped, match.index),
        rule,
      });
    }
  }

  return violations;
};

/** Playwright config: any `retries` other than 0. */
export const checkConfig = (file: string, source: string): TestViolation[] => {
  const stripped = stripTs(source);
  const violations: TestViolation[] = [];
  const pattern = /\bretries\s*:\s*(?<count>\d+)/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(stripped)) !== null) {
    if (match.groups?.count !== "0") {
      violations.push({
        file,
        hint: hintFor("no-test-retry"),
        line: lineOf(stripped, match.index),
        rule: "no-test-retry",
      });
    }
  }

  return violations;
};

/** Playwright specs: no retry keys or retry branching, no wall-clock waits. */
export const checkE2e = (file: string, source: string): TestViolation[] => {
  const stripped = stripTs(source);

  const violations: TestViolation[] = scanPatterns(
    file,
    stripped,
    TS_SLEEPS,
    "no-wall-clock-sleep"
  );

  const retryPatterns: SleepPattern[] = [
    {
      hint: hintFor("no-test-retry"),
      pattern: /\bretries\s*:/u,
    },
    {
      hint: hintFor("no-test-retry"),
      pattern: /\btest\s*\.\s*info\s*\(\s*\)\s*\.\s*retry\b/u,
    },
    {
      hint: hintFor("no-test-retry"),
      pattern: /\btestInfo\s*\.\s*retry\b/u,
    },
  ];

  return [
    ...violations,
    ...scanPatterns(file, stripped, retryPatterns, "no-test-retry"),
  ];
};

/** UI unit tests: no wall-clock waits, unless the file runs under fake
 * timers. */
export const checkUiTest = (file: string, source: string): TestViolation[] => {
  const stripped = stripTs(source);

  if (
    /useFakeTimers/u.test(stripped) ||
    /globalThis\s*\.\s*setTimeout\s*=/u.test(stripped)
  ) {
    return [];
  }

  return scanPatterns(file, stripped, TS_SLEEPS, "no-wall-clock-sleep");
};

const RUST_SLEEPS: SleepPattern[] = [
  {
    hint: "await a Notify/watch signal, a barrier, or run the test under paused time instead",
    pattern: /\bstd::thread::sleep\s*\(/u,
  },
  {
    hint: "run the test under paused time (#[tokio::test(start_paused = true)] or tokio::time::pause()) or replace the wait with a barrier, Notify or watch signal",
    pattern: /\btokio::time::sleep\s*\(/u,
  },
  {
    hint: "run the test under paused time (#[tokio::test(start_paused = true)] or tokio::time::pause()) or replace the wait with a barrier, Notify or watch signal",
    pattern: /\btokio::time::sleep_until\s*\(/u,
  },
];

/** Rust test code: sleeps fail unless their test runs under paused time.
 * `inTestFile` marks `tests.rs` files, `tests/` dirs and `#[cfg(test)]`
 * declaration-gated modules, whose whole body is test code. */
export const checkRust = (
  file: string,
  source: string,
  inTestFile: boolean
): TestViolation[] => {
  const stripped = stripRust(source);

  const spans = inTestFile
    ? [{ end: stripped.length, start: 0 }]
    : cfgTestSpans(stripped);

  if (spans.length === 0) {
    return [];
  }

  const fns = testFns(stripped);
  const violations: TestViolation[] = [];

  for (const { hint, pattern } of RUST_SLEEPS) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    let match: RegExpExecArray | null;

    while ((match = global.exec(stripped)) !== null) {
      const at = match.index;

      if (!spans.some((span) => span.start <= at && at < span.end)) {
        continue;
      }

      const enclosing = fns.find((fn) => fn.start <= at && at < fn.end);

      if (
        enclosing !== undefined &&
        (enclosing.attr.includes("start_paused") ||
          enclosing.body.includes("tokio::time::pause()"))
      ) {
        continue;
      }

      violations.push({
        file,
        hint,
        line: lineOf(stripped, at),
        rule: "no-wall-clock-sleep",
      });
    }
  }

  return violations;
};

/** Makefile, shell scripts, workflows: no `--retries` flag. */
export const checkFlags = (file: string, source: string): TestViolation[] => {
  const code = source.replaceAll(/(?<gap>^|\s)#.*$/gmu, "$<gap>");
  const violations: TestViolation[] = [];
  const pattern = /--retries(?![\w-])/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    violations.push({
      file,
      hint: hintFor("no-retry-flag"),
      line: lineOf(code, match.index),
      rule: "no-retry-flag",
    });
  }

  return violations;
};

const walk = (dir: string, match: (name: string) => boolean): string[] => {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...walk(full, match));
    } else if (match(entry.name)) {
      out.push(full);
    }
  }

  return out;
};

const main = (): void => {
  const root = new URL("../", import.meta.url).pathname;
  const override = process.env.CHECK_TESTS_ROOT;
  const base = override ?? root;
  const rel = (full: string): string => path.relative(base, full);
  let violations: TestViolation[] = [];
  let scanned = 0;
  const config = path.join(base, "apps/noite/playwright.config.ts");
  violations.push(...checkConfig(rel(config), readFileSync(config, "utf-8")));
  scanned += 1;

  for (const full of walk(path.join(base, "apps/noite/e2e"), (name) =>
    name.endsWith(".ts")
  )) {
    violations.push(...checkE2e(rel(full), readFileSync(full, "utf-8")));
    scanned += 1;
  }

  for (const full of walk(
    path.join(base, "apps/noite/src"),
    (name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx")
  )) {
    violations.push(...checkUiTest(rel(full), readFileSync(full, "utf-8")));
    scanned += 1;
  }

  const runnerSrc = path.join(base, "apps/runner/src");
  const gated = new Set<string>();

  for (const rootFile of ["main.rs", "lib.rs"]) {
    const full = path.join(runnerSrc, rootFile);

    try {
      const names = cfgTestFiles(stripRust(readFileSync(full, "utf-8")));

      for (const name of names) {
        gated.add(name);
      }
    } catch {
      // No such crate root: nothing gated there.
    }
  }

  const rustRoots = [runnerSrc];
  const testsDir = path.join(base, "apps/runner/tests");

  try {
    if (statSync(testsDir).isDirectory()) {
      rustRoots.push(testsDir);
    }
  } catch {
    // No integration-tests dir: unit tests only.
  }

  for (const dir of rustRoots) {
    for (const full of walk(dir, (name) => name.endsWith(".rs"))) {
      const name = path.basename(full);
      const underTests = rel(full).split(path.sep).includes("tests");
      violations.push(
        ...checkRust(
          rel(full),
          readFileSync(full, "utf-8"),
          underTests || name === "tests.rs" || gated.has(name)
        )
      );
      scanned += 1;
    }
  }

  violations.push(
    ...checkFlags(
      "Makefile",
      readFileSync(path.join(base, "Makefile"), "utf-8")
    )
  );
  scanned += 1;

  for (const full of walk(path.join(base, "docker"), (name) =>
    name.endsWith(".sh")
  )) {
    violations.push(...checkFlags(rel(full), readFileSync(full, "utf-8")));
    scanned += 1;
  }

  for (const full of walk(
    path.join(base, ".github/workflows"),
    (name) => name.endsWith(".yml") || name.endsWith(".yaml")
  )) {
    violations.push(...checkFlags(rel(full), readFileSync(full, "utf-8")));
    scanned += 1;
  }

  violations = violations.toSorted((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }

    return a.line - b.line;
  });

  for (const violation of violations) {
    console.log(
      `${violation.file}:${violation.line}: ${violation.rule} — ${violation.hint}`
    );
  }

  if (violations.length > 0) {
    console.log(
      `check-tests: ${violations.length} violation(s) in ${scanned} file(s)`
    );
    process.exit(1);
  }

  console.log(`check-tests: clean (${scanned} files)`);
};

if (import.meta.main) {
  main();
}
