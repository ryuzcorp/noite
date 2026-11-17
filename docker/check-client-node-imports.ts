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
 * uses Bun's own parser (`Transpiler.scanImports`), so a comment or string
 * that merely mentions a builtin never counts. `bun run build` in ci.yml's
 * `worker` job still proves workerd-compat; this proves the browser half.
 *
 * Second layer (the build itself): `apps/noite/vite.config.ts`
 * (`failOnExternalizedBuiltin`) turns Vite's `has been externalized for
 * browser compatibility` warning into a build error naming the specifier
 * and importer. The source walk drops bare specifiers, so a page-reachable
 * dependency importing `node:fs` builds and binds to the same stub
 * invisibly — the build gate catches it with Vite's real resolution (no
 * false positives on node-only export branches, which a `node_modules`
 * source walk would hit; and no dist-content shape match, which a
 * legitimate empty CJS dependency also compiles to).
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

/** One static import edge out of a module. */
export interface ClientImport {
  /** The specifier as written (`node:async_hooks`, `./detail`, `$lib/x`). */
  readonly specifier: string;
  /** 1-based line of the quoted specifier (first occurrence per edge). */
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

const transpiler = new Bun.Transpiler({ loader: "tsx" });

/**
 * Line of the next quoted occurrence of `specifier` at or after `from`
 * (either quote style), plus the offset just past it so a repeated
 * specifier attributes each occurrence in order. The edge itself already
 * comes from the parser below — this only locates it for the report, so a
 * first-occurrence search is enough. Unreachable in practice (the parser
 * saw the quoted specifier in this same source): falls back to the last
 * line rather than throwing the scan away.
 */
const specifierLine = (source: string, specifier: string, from: number) => {
  const hits = [`"${specifier}"`, `'${specifier}'`].flatMap((quoted) => {
    const at = source.indexOf(quoted, from);

    return at === -1 ? [] : [at];
  });

  if (hits.length === 0) {
    return { end: source.length, line: lineOf(source, source.length) };
  }

  const at = Math.min(...hits);

  return { end: at + specifier.length + 2, line: lineOf(source, at) };
};

/**
 * Every static value-level import edge out of `source` — `import … from`,
 * side-effect `import "…"`, `export … from` — via Bun's own parser
 * (`Transpiler.scanImports`) instead of a regex. A quote inside a comment
 * in the import's middle defeated the old middle-matcher (the edge vanished
 * entirely), and import text inside a template string faked an edge the
 * stripTs check could not always see. The parser handles comments, strings
 * and type-only edges (`import type`, `export type`, `export { type … }`
 * are erased before the bundle and dropped here); only `import-statement`
 * edges count, so dynamic `import()` stays out of scope (lazy boundary,
 * and the incident shape is a static edge).
 */
export const parseStaticImports = (source: string): ClientImport[] => {
  const offsets = new Map<string, number>();
  const imports: ClientImport[] = [];

  for (const edge of transpiler.scanImports(source)) {
    if (edge.kind !== "import-statement") {
      continue;
    }

    const found = specifierLine(source, edge.path, offsets.get(edge.path) ?? 0);
    offsets.set(edge.path, found.end);
    imports.push({ line: found.line, specifier: edge.path });
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

/**
 * Build half of the guard lives in `apps/noite/vite.config.ts`
 * (`failOnExternalizedBuiltin`): Vite externalizes a client-bundled `node:`
 * import to an empty browser stub with only a warning and exit 0, so the
 * build itself throws when that warning fires — naming the specifier and
 * importer. That is what catches builtins arriving through a dependency
 * (bare specifiers are invisible to the source walk below) with Vite's real
 * browser-condition resolution. A dist-content shape match was rejected:
 * a legitimate empty CJS dependency compiles to the identical stub shape
 * (false positive), and the shape drifts with the bundler (fails open).
 */

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

const main = (): void => {
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

if (import.meta.main) {
  main();
}
