#!/usr/bin/env bun
/**
 * Worker-rules guard for the control worker's server code: nothing crosses
 * requests. A client abort (or a fast answer) drops the starter's pending
 * work, so any promise, cache or client shared between requests must be
 * registered with `ctx.waitUntil` or time-bounded — otherwise the next
 * requests for the same store wait on the orphan until the 15 s route
 * timeout (flake H's 15.01 s pair).
 *
 *   bun docker/check-worker-rules.ts
 *                                            ...scans the worker server tree
 *
 * Two rules, both with a fail-before unit test behind them (not just this
 * scan):
 * - `no-shared-inflight`: a module-level in-flight promise, cache or client
 *   in worker server code. `setupPasses` (`lib/db.ts`) is the one allowed
 *   instance: every stored pass is `waitUntil`-registered and waiters are
 *   time-bounded (`db.test.ts` pins both). Anything new fails here until it
 *   is registered or split per request — and it gets its own test.
 * - `no-unbounded-store-read`: the better-auth session read reaches D1 with
 *   no timeout anywhere in its chain, so it must go through the bounded
 *   wrapper in `lib/server/session.server.ts` (5 s, throws instead of
 *   hanging). Any other call site would reintroduce the unbounded wait.
 *
 * Scope (worker server code only — the client tree under `lib/` keeps its
 * own module caches, which never run in the worker):
 * - `apps/noite/src/lib/server/`, `apps/noite/src/http/routes/`,
 *   `apps/noite/src/http/*.ts`, `apps/noite/src/middleware/`
 * - `apps/noite/src/lib/{db,runner,auth,collaborators,control-env,rate-limit,env-auth}.ts`
 *
 * The pure scanners are exported for `check-worker-rules.test.ts`; running
 * this file executes the repo scan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stripTs } from "./check-tests";

export type WorkerRule = "no-shared-inflight" | "no-unbounded-store-read";

export interface WorkerViolation {
  file: string;
  hint: string;
  line: number;
  rule: WorkerRule;
}

const hintFor = (rule: WorkerRule): string => {
  if (rule === "no-shared-inflight") {
    return "module-level shared async work in worker server code: register it with ctx.waitUntil or keep it per request (see SPEC.md Worker code rules)";
  }

  return "unbounded better-auth session read: call getSessionOrNull (lib/server/session.server.ts), never auth.api.getSession directly";
};

/** `(file, name)` pairs that may hold module-level shared async work. */
const SHARED_ALLOWLIST: readonly (readonly [string, string])[] = [
  ["apps/noite/src/lib/db.ts", "setupPasses"],
];

/** Worker server files: directories plus the shared lib modules. `http/`
 * already covers `http/routes/`. */
const scopeRoots = (root: string): string[] => [
  path.join(root, "apps/noite/src/lib/server"),
  path.join(root, "apps/noite/src/http"),
  path.join(root, "apps/noite/src/middleware"),
  path.join(root, "apps/noite/src/lib/db.ts"),
  path.join(root, "apps/noite/src/lib/runner.ts"),
  path.join(root, "apps/noite/src/lib/auth.ts"),
  path.join(root, "apps/noite/src/lib/collaborators.ts"),
  path.join(root, "apps/noite/src/lib/control-env.ts"),
  path.join(root, "apps/noite/src/lib/rate-limit.ts"),
  path.join(root, "apps/noite/src/lib/env-auth.ts"),
];

const TS_EXT = {
  ".ts": true,
  ".tsx": true,
} satisfies Record<string, true>;

const isTest = (name: string): boolean =>
  name.endsWith(".test.ts") || name.endsWith(".test.tsx");

const walk = (entry: string, out: string[]): void => {
  const stat = statSync(entry, { throwIfNoEntry: false });

  if (!stat) {
    return;
  }

  if (stat.isFile()) {
    if (
      Object.hasOwn(TS_EXT, path.extname(entry)) &&
      !isTest(path.basename(entry))
    ) {
      out.push(entry);
    }

    return;
  }

  for (const name of readdirSync(entry).toSorted()) {
    walk(path.join(entry, name), out);
  }
};

/** The whole declaration: a return type or an initializer can run over
 * several lines, so accumulate until the brackets opened on it close, a
 * terminator lands, or the cap hits (a runaway is a parse the scanner
 * should not chase).
 */
const readStatement = (lines: string[], index: number): string => {
  let statement = lines[index] ?? "";
  let depth = 0;
  let cursor = index;

  while (cursor < lines.length && cursor < index + 10) {
    const current = lines[cursor] ?? "";

    for (const char of current) {
      if (char === "(" || char === "{" || char === "[") {
        depth += 1;
      } else if (char === ")" || char === "}" || char === "]") {
        depth -= 1;
      }
    }

    if (cursor > index) {
      statement += ` ${current}`;
    }

    cursor += 1;

    if (depth <= 0 && /[;,]$/u.test(current.trimEnd())) {
      break;
    }
  }

  return statement;
};

/**
 * Whether the declaration is itself a function: an arrow at the
 * statement's own depth. A `Promise` there annotates the return type, it is
 * not a stored promise. Arrows nested inside an initializer (a `.map`
 * building the initial value, a `Cache.make` lookup) still count.
 */
const isPlainFunction = (statement: string): boolean => {
  let nested = 0;

  for (let i = 0; i + 1 < statement.length; i += 1) {
    const char = statement[i];

    if (char === "(" || char === "{" || char === "[") {
      nested += 1;
    } else if (char === ")" || char === "}" || char === "]") {
      nested -= 1;
    } else if (char === "=" && statement[i + 1] === ">" && nested === 0) {
      return true;
    }
  }

  return false;
};

/**
 * Flag module-level bindings that can hold a cross-request promise, cache
 * or client: `new Map/WeakMap/Set` mentioning promises or in-flight work,
 * `Cache.make(`, or a bare `Promise` binding. Comment/string content is
 * already blanked, and only column-zero declarations count (indented ones
 * live inside a function and die with the request).
 */
export const checkSharedInflight = (
  file: string,
  source: string
): WorkerViolation[] => {
  const stripped = stripTs(source).split("\n");
  const violations: WorkerViolation[] = [];

  for (let index = 0; index < stripped.length; index += 1) {
    const line = stripped[index] ?? "";
    const match = /^(?:export\s+)?(?:const|let|var)\s+(?<name>\w+)/u.exec(line);

    if (!match?.groups?.name) {
      continue;
    }

    const { name } = match.groups;

    // A value that is itself a direct call (`= apiAction(`): an arrow on a
    // later line is that call's callback, not a stored promise. (A promise
    // built by a disguised factory call evades this tripwire; the scan
    // targets the direct shapes, review covers the rest.)
    if (/[=]\s*[\w$.]+\($/u.test(line)) {
      continue;
    }

    const statement = readStatement(stripped, index);

    if (isPlainFunction(statement)) {
      continue;
    }

    const shared =
      /new\s+(?:Map|WeakMap|Set)\s*[<(]/u.test(statement) &&
      /Promise|inflight|in-flight|pending|Deferred|Cache|flight/u.test(
        statement
      );

    const cached = /Cache\.make\s*\(/u.test(statement);

    const promised =
      /:\s*Promise\s*[<]/u.test(statement) ||
      /[=]\s*new\s+Promise\s*\(/u.test(statement);

    if (!(shared || cached || promised)) {
      continue;
    }

    const allowed = SHARED_ALLOWLIST.some(
      ([allowedFile, allowedName]) =>
        file === allowedFile && name === allowedName
    );

    if (!allowed) {
      violations.push({
        file,
        hint: hintFor("no-shared-inflight"),
        line: index + 1,
        rule: "no-shared-inflight",
      });
    }
  }

  return violations;
};

/** The session read must go through the bounded wrapper. */
export const checkStoreReads = (
  file: string,
  source: string
): WorkerViolation[] => {
  if (file === "apps/noite/src/lib/server/session.server.ts") {
    return [];
  }

  const stripped = stripTs(source).split("\n");
  const violations: WorkerViolation[] = [];

  for (let index = 0; index < stripped.length; index += 1) {
    if (/auth\.api\.getSession\s*\(/u.test(stripped[index] ?? "")) {
      violations.push({
        file,
        hint: hintFor("no-unbounded-store-read"),
        line: index + 1,
        rule: "no-unbounded-store-read",
      });
    }
  }

  return violations;
};

const main = (): void => {
  const root = new URL("../", import.meta.url).pathname;
  const files: string[] = [];

  for (const entry of scopeRoots(root)) {
    walk(entry, files);
  }

  let violations: WorkerViolation[] = [];

  for (const full of files) {
    const rel = path.relative(root, full);
    const source = readFileSync(full, "utf-8");

    violations.push(
      ...checkSharedInflight(rel, source),
      ...checkStoreReads(rel, source)
    );
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
      `check-worker-rules: ${violations.length} violation(s) in ${files.length} file(s)`
    );
    process.exit(1);
  }

  console.log(`check-worker-rules: clean (${files.length} files)`);
};

if (import.meta.main) {
  main();
}
