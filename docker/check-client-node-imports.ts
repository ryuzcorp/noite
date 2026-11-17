#!/usr/bin/env bun
/**
 * Client-bundle node-builtin guard, run in `check.yml`: no page-reachable
 * module may statically import a `node:` builtin (or a bare Node builtin
 * like `fs` or `async_hooks`) that would execute in the browser. The
 * browser resolves those specifiers to stubs that throw at module load, so
 * one static edge kills the whole island chunk with no fetch ever firing —
 * the #371 storage/admin outage (`request-timeout.ts` built an
 * `AsyncLocalStorage` at module load via `lib/runner.ts`).
 *
 * Mechanism: a source import-graph walk from the page entries, not a scan
 * of the built output. The incident bundle built fine — Vite had already
 * replaced `node:async_hooks` with its stub, so the specifier is gone from
 * `dist` and an output grep passes on the exact tree that broke the pages.
 * The walk sees the real edge, names the module chain, needs no build, and
 * (via `stripTs`) cannot trip on a comment or string that merely mentions
 * a builtin. `bun run build` in ci.yml's `worker` job still proves
 * workerd-compat; this proves the browser half.
 *
 * Second layer (`--dist`, after `bun run build`): fail when a built client
 * chunk contains Vite's inlined stub factory for an externalized builtin.
 * The source walk drops bare specifiers, so a page-reachable dependency
 * importing `node:fs` builds and binds to the same stub invisibly — the
 * dist scan catches it with Vite's real resolution (no false positives on
 * node-only export branches, which a `node_modules` source walk would hit).
 * Only `dist/client` is read; the worker bundle legitimately keeps `node:`.
 * Scope: static ESM edges only (`import … from`, side-effect `import`,
 * `export … from`). `import type` / `export type` are erased before the
 * bundle and ignored, as is dynamic `import()` (a lazy boundary that may
 * never execute in the browser — the incident shape is a static edge).
 * The walk follows every reachable file, including `*.server.ts`: no page
 * imports one today, and such an edge executes server code in the browser
 * (the #369 schema-import build break), so flagging its builtins with the
 * full chain is correct, not a false positive. Bare npm/virtual imports
 * (`effect/Schema`, `@ilha/void`, `ilha:pages/*`) are bundled normally and
 * never followed.
 *
 * The fix for a violation is the #371 split: move the builtin behind a
 * server-only module (like `lib/request-timeout-node.ts`, imported only
 * from server entries — `middleware/`, `routes/`, `http/`, `lib/server/`)
 * and keep the shared contract client-safe.
 *
 * The pure scanners are exported for `check-client-node-imports.test.ts`;
 * running this file executes the repo scan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { stripTs } from "./check-tests";

/** One static import edge out of a module. */
export interface ClientImport {
  /** The specifier as written (`node:async_hooks`, `./detail`, `$lib/x`). */
  readonly specifier: string;
  /** 1-based line of the `import`/`export` keyword. */
  readonly line: number;
}

/** A builtin import reachable from a page. */
export interface ClientNodeViolation {
  /** Repo-relative path of the module holding the builtin import. */
  readonly file: string;
  /** 1-based line of the static import. */
  readonly line: number;
  /** The builtin specifier as written. */
  readonly specifier: string;
  /** The page → … → file chain, repo-relative. */
  readonly chain: readonly string[];
}

/** Every Node builtin by bare name (`fs`, `async_hooks`, `fs/promises`). */
const BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.map((name) =>
    name.startsWith("node:") ? name.slice("node:".length) : name
  )
);

/** Whether the specifier resolves to a Node builtin in the browser. */
export const isNodeSpecifier = (specifier: string): boolean => {
  if (specifier.startsWith("node:")) {
    return specifier.length > "node:".length;
  }

  return BUILTINS.has(specifier);
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

/** A braced only-type item list (`{ type A, type B }`): erased, ignorable. */
const isTypeOnlyMiddle = (middle: string): boolean => {
  if (/^\s*type\b/u.test(middle)) {
    return true;
  }

  const braced = /^\s*\{(?<body>[\s\S]*)\}\s*$/u.exec(middle);

  if (!braced) {
    return false;
  }

  const items = (braced.groups?.body ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 && items.every((item) => /^\s*type\b/u.test(item));
};

interface RawEdge {
  keyword: string;
  keywordStart: number;
  line: number;
  middle: string;
  specifier: string;
}

/**
 * Candidate static edges from the raw source. The middle (between the
 * keyword and `from`) excludes quotes and semicolons, so a match can never
 * span statements; each candidate is then validated against the
 * comment/string/regex-blanked source, where a match inside a comment or a
 * string has no literal keyword left to stand on.
 */
const rawEdges = (source: string): RawEdge[] => {
  const edges: RawEdge[] = [];

  const fromPattern =
    /\b(?<keyword>import|export)\b(?<middle>[^;'"]*?)\bfrom\s*(?<quote>['"])(?<specifier>(?:(?!\k<quote>)[^\\\n]|\\.)*)\k<quote>/gu;

  const barePattern =
    /\bimport\s*(?<quote>['"])(?<specifier>(?:(?!\k<quote>)[^\\\n]|\\.)*)\k<quote>/gu;

  for (const match of source.matchAll(fromPattern)) {
    edges.push({
      keyword: match.groups?.keyword ?? "",
      keywordStart: match.index,
      line: lineOf(source, match.index),
      middle: match.groups?.middle ?? "",
      specifier: match.groups?.specifier ?? "",
    });
  }

  for (const match of source.matchAll(barePattern)) {
    edges.push({
      keyword: "import",
      keywordStart: match.index,
      line: lineOf(source, match.index),
      middle: "",
      specifier: match.groups?.specifier ?? "",
    });
  }

  return edges;
};

/**
 * Every static value-level import edge out of `source`: `import … from`,
 * side-effect `import "…"`, `export … from`. Type-only edges
 * (`import type`, `export { type X } from`) are erased before the bundle.
 * Dynamic `import()` is deliberately out of scope (lazy boundary, and the
 * incident shape is a static edge).
 */
export const parseStaticImports = (source: string): ClientImport[] => {
  const stripped = stripTs(source);
  const imports: ClientImport[] = [];

  for (const edge of rawEdges(source)) {
    if (
      stripped.slice(
        edge.keywordStart,
        edge.keywordStart + edge.keyword.length
      ) !== edge.keyword
    ) {
      continue;
    }

    if (edge.middle !== "" && isTypeOnlyMiddle(edge.middle)) {
      continue;
    }

    imports.push({ line: edge.line, specifier: edge.specifier });
  }

  return imports.toSorted((a, b) => a.line - b.line);
};

/**
 * Follow a relative or `$lib/` edge to a repo-relative `.ts`/`.tsx` path,
 * or `null` for npm/virtual/bare specifiers the bundler owns. `exists`
 * keeps this pure for tests; the repo scan passes a source-map lookup.
 */
export const resolveClientImport = (
  fromFile: string,
  specifier: string,
  exists: (candidate: string) => boolean
): string | null => {
  let base: string;

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), specifier)
    );
  } else if (specifier.startsWith("$lib/")) {
    base = `apps/noite/src/lib/${specifier.slice("$lib/".length)}`;
  } else {
    return null;
  }

  const stem =
    base.endsWith(".ts") || base.endsWith(".tsx")
      ? base
      : base.replace(/\.jsx?$/u, "");

  const candidates =
    stem === base && (base.endsWith(".ts") || base.endsWith(".tsx"))
      ? [stem]
      : [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`];

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  return null;
};

/**
 * Walk the client graph from the page `entries` over `sources`
 * (repo-relative path → content) and report every builtin import with the
 * chain that pulls it into the browser.
 */
export const checkClientGraph = (
  entries: readonly string[],
  sources: ReadonlyMap<string, string>
): ClientNodeViolation[] => {
  const exists = (candidate: string): boolean => sources.has(candidate);
  const violations: ClientNodeViolation[] = [];
  const visited = new Set<string>();

  const queue: { chain: string[]; file: string }[] = entries.map((file) => ({
    chain: [],
    file,
  }));

  let head = 0;

  while (head < queue.length) {
    const current = queue[head] ?? { chain: [], file: "" };
    head += 1;

    if (visited.has(current.file)) {
      continue;
    }

    visited.add(current.file);

    const source = sources.get(current.file);

    if (source === undefined) {
      continue;
    }

    for (const edge of parseStaticImports(source)) {
      if (isNodeSpecifier(edge.specifier)) {
        violations.push({
          chain: [...current.chain, current.file],
          file: current.file,
          line: edge.line,
          specifier: edge.specifier,
        });

        continue;
      }

      const target = resolveClientImport(current.file, edge.specifier, exists);

      if (target !== null && !visited.has(target)) {
        queue.push({ chain: [...current.chain, current.file], file: target });
      }
    }
  }

  return violations.toSorted((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }

    return a.line - b.line;
  });
};

/**
 * Fail closed: an empty page set means the entry scan found nothing (a moved
 * pages directory, a broken walk), not a clean tree — without this,
 * `checkClientGraph` over zero entries reports zero violations and the gate
 * prints `clean (0 pages)` with exit 0. Exported for tests; `main` turns
 * the throw into the failure below.
 */
export const requireClientEntries = (entries: readonly string[]): void => {
  if (entries.length === 0) {
    throw new Error(
      "check-client-node-imports: no client pages found under apps/noite/src/pages/ — the entry scan is broken, failing closed"
    );
  }
};

/** A built client chunk that bundles a stubbed Node builtin. */
export interface ClientDistViolation {
  /** The chunk path relative to the repo root. */
  file: string;
}

/**
 * Vite 8 (Rolldown) inlines an externalized browser builtin as a stub
 * factory passed to the CJS interop helper — e.g.
 * `(0,e(((e,t)=>{t.exports={}}))().readFileSync)(...)` for a bundled
 * `node:fs` (captured from vite 8.3.8 output; re-capture the fixture in
 * `check-client-node-imports.test.ts` when Vite is bumped). The parameter
 * names are minified per chunk, so only the shape is matched: an arrow
 * factory whose whole body assigns `{}` to `.exports`, passed as a call
 * argument. The worker/SSR bundles keep real `node:` imports (workerd
 * supports them), so only `dist/client` is scanned — `.js` only, since
 * sourcemaps carry the original specifiers in `sourcesContent`.
 */
export const DIST_STUB_PATTERN =
  /\(\(\([\w$]+,[\w$]+\)=>\{[\w$]+\.exports=\{\}\}\)\)/u;

/**
 * Built client chunks (`files` is chunk path → content) that bundle a
 * stubbed builtin. Pure for tests; the repo scan reads `dist/client`.
 */
export const checkBuiltClient = (
  files: ReadonlyMap<string, string>
): ClientDistViolation[] => {
  const violations: ClientDistViolation[] = [];

  for (const [file, content] of files) {
    if (!file.endsWith(".js")) {
      continue;
    }

    if (DIST_STUB_PATTERN.test(content)) {
      violations.push({ file });
    }
  }

  return violations.toSorted((a, b) => (a.file < b.file ? -1 : 1));
};

const TS_EXT = {
  ".ts": true,
  ".tsx": true,
} satisfies Record<string, true>;

const isTest = (name: string): boolean =>
  name.endsWith(".test.ts") || name.endsWith(".test.tsx");

const isServerModule = (name: string): boolean => name.includes(".server.");

/** Client entries: every page module the browser loads, minus its server pair. */
const isClientEntry = (relative: string): boolean =>
  relative.startsWith("apps/noite/src/pages/") &&
  Object.hasOwn(TS_EXT, path.extname(relative)) &&
  !isServerModule(relative) &&
  !isTest(path.basename(relative));

const walkSources = (
  entry: string,
  root: string,
  sources: Map<string, string>
): void => {
  const stat = statSync(entry, { throwIfNoEntry: false });

  if (!stat) {
    return;
  }

  if (stat.isFile()) {
    if (
      Object.hasOwn(TS_EXT, path.extname(entry)) &&
      !isTest(path.basename(entry))
    ) {
      sources.set(path.relative(root, entry), readFileSync(entry, "utf-8"));
    }

    return;
  }

  for (const name of readdirSync(entry).toSorted()) {
    walkSources(path.join(entry, name), root, sources);
  }
};

const checkSources = (): void => {
  const root = new URL("../", import.meta.url).pathname;
  const sources = new Map<string, string>();

  walkSources(path.join(root, "apps/noite/src"), root, sources);

  const entries = [...sources.keys()].filter((file) => isClientEntry(file));

  try {
    requireClientEntries(entries);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const violations = checkClientGraph(entries, sources);

  for (const violation of violations) {
    console.log(
      `${violation.file}:${violation.line}: client bundle imports node builtin "${violation.specifier}" via ${violation.chain.join(" -> ")} — move the builtin behind a server-only module (like lib/request-timeout-node.ts, imported only from middleware/routes/http/lib/server) and keep the shared contract client-safe; the browser resolves node: builtins to stubs that throw at module load, killing the island chunk`
    );
  }

  if (violations.length > 0) {
    console.log(
      `check-client-node-imports: ${violations.length} violation(s) from ${entries.length} page(s)`
    );
    process.exit(1);
  }

  console.log(
    `check-client-node-imports: clean (${entries.length} pages, ${sources.size} modules)`
  );
};

/**
 * The `bun run build` half of the guard: fail when a built client chunk
 * bundles a stubbed builtin. This is what catches builtins arriving through
 * a dependency — the source walk drops bare specifiers, so a
 * page-reachable `node_modules` package importing `node:fs` builds and
 * binds to the same stub. Vite uses its real (browser-condition) resolution
 * here, so unlike a `node_modules` source walk this cannot false-positive
 * on node-only export branches. Run with `--dist` after the build; only
 * `dist/client` is read (the worker bundle legitimately keeps `node:`
 * imports).
 */
const checkDist = (): void => {
  const root = new URL("../", import.meta.url).pathname;
  const distClient = path.join(root, "apps/noite/dist/client");
  const chunks = new Map<string, string>();

  const readChunks = (dir: string): void => {
    let names: string[];

    try {
      names = readdirSync(dir).toSorted();
    } catch {
      console.log(
        "check-client-node-imports --dist: apps/noite/dist/client is missing — run `bun run build` in apps/noite first"
      );
      process.exit(1);
    }

    for (const name of names) {
      const full = path.join(dir, name);
      const stat = statSync(full, { throwIfNoEntry: false });

      if (!stat) {
        continue;
      }

      if (stat.isDirectory()) {
        readChunks(full);
      } else if (name.endsWith(".js")) {
        chunks.set(path.relative(root, full), readFileSync(full, "utf-8"));
      }
    }
  };

  readChunks(distClient);

  if (chunks.size === 0) {
    console.log(
      "check-client-node-imports --dist: no client chunks found under apps/noite/dist/client — the build emitted nothing, failing closed"
    );
    process.exit(1);
  }

  const violations = checkBuiltClient(chunks);

  for (const violation of violations) {
    console.log(
      `${violation.file}: built client chunk bundles a stubbed node builtin (an externalized browser import) — find it via the build warning \`Module ... has been externalized for browser compatibility, imported by ...\` or the source walk above; move the builtin behind a server-only module`
    );
  }

  if (violations.length > 0) {
    console.log(
      `check-client-node-imports --dist: ${violations.length} violation(s) in ${chunks.size} chunk(s)`
    );
    process.exit(1);
  }

  console.log(
    `check-client-node-imports --dist: clean (${chunks.size} chunks)`
  );
};

const main = (): void => {
  if (process.argv.includes("--dist")) {
    checkDist();

    return;
  }

  checkSources();
};

if (import.meta.main) {
  main();
}
