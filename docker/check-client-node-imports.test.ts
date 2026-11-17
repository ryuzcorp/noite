import { describe, expect, test } from "bun:test";

import {
  checkClientGraph,
  isNodeSpecifier,
  parseStaticImports,
  requireClientEntries,
  resolveClientImport,
} from "./check-client-node-imports";

describe("parseStaticImports", () => {
  test("a static node: import is an edge with its line", () => {
    const source = [
      'import { AsyncLocalStorage } from "node:async_hooks";',
      "",
    ].join("\n");

    expect(parseStaticImports(source)).toEqual([
      { line: 1, specifier: "node:async_hooks" },
    ]);
  });

  test("side-effect and re-export edges count", () => {
    const source = [
      'import "./polyfill";',
      'export { run } from "./runner";',
      "",
    ].join("\n");

    expect(parseStaticImports(source)).toEqual([
      { line: 1, specifier: "./polyfill" },
      { line: 2, specifier: "./runner" },
    ]);
  });

  test("type-only edges are erased before the bundle", () => {
    const source = [
      'import type { App } from "./runner-types/App";',
      'export type { App } from "./runner-types/App";',
      'export { type App } from "./runner-types/App";',
      'import { value } from "./runner";',
      "",
    ].join("\n");

    expect(parseStaticImports(source)).toEqual([
      { line: 4, specifier: "./runner" },
    ]);
  });

  test("a mixed type/value re-export still counts", () => {
    const source = ['export { type App, run } from "./runner";', ""].join("\n");

    expect(parseStaticImports(source)).toEqual([
      { line: 1, specifier: "./runner" },
    ]);
  });

  test("commented-out and string-held imports are not code", () => {
    const source = [
      '// import { x } from "node:fs";',
      '/* export { y } from "node:path"; */',
      "const doc = \"import z from 'node:crypto'\";",
      'import { real } from "node:os";',
      "",
    ].join("\n");

    expect(parseStaticImports(source)).toEqual([
      { line: 4, specifier: "node:os" },
    ]);
  });

  test("dynamic import() is a lazy boundary, not a static edge", () => {
    const source = [
      'const mod = await import("node:fs");',
      'import("./lazy");',
      "",
    ].join("\n");

    expect(parseStaticImports(source)).toEqual([]);
  });

  test("a comment holding a quote inside the import still counts", () => {
    const source = [
      'import /* "x" */ { readFileSync } from "node:fs";',
      "",
    ].join("\n");

    expect(parseStaticImports(source)).toEqual([
      { line: 1, specifier: "node:fs" },
    ]);
  });

  test("import text inside a template string is not code", () => {
    const source = [
      'export const help = `import { readFileSync } from "node:fs"`;',
      "",
    ].join("\n");

    expect(parseStaticImports(source)).toEqual([]);
  });

  test("a generic arrow parses under the ts loader", () => {
    // `tsx` reads `<T>` as JSX and throws on the `.ts` files that use it,
    // so the graph passes each file's own extension.
    const source = [
      "const tracked = <T>(key: string): string => key;",
      'import { x } from "node:fs";',
      "",
    ].join("\n");

    expect(parseStaticImports(source, "ts")).toEqual([
      { line: 2, specifier: "node:fs" },
    ]);
  });
});

describe("isNodeSpecifier", () => {
  test("node: builtins and bare builtins count, bundles do not", () => {
    expect(isNodeSpecifier("node:async_hooks")).toBe(true);
    expect(isNodeSpecifier("node:fs/promises")).toBe(true);
    expect(isNodeSpecifier("async_hooks")).toBe(true);
    expect(isNodeSpecifier("fs")).toBe(true);
    expect(isNodeSpecifier("crypto")).toBe(true);
    expect(isNodeSpecifier("effect/Schema")).toBe(false);
    expect(isNodeSpecifier("@ilha/void")).toBe(false);
    expect(isNodeSpecifier("./request-timeout")).toBe(false);
    expect(isNodeSpecifier("$lib/runner")).toBe(false);
  });
});

describe("resolveClientImport", () => {
  const files = new Set([
    "apps/noite/src/pages/storage/x.tsx",
    "apps/noite/src/lib/runner.ts",
    "apps/noite/src/lib/detail/index.ts",
  ]);

  const exists = (candidate: string): boolean => files.has(candidate);

  test("relative, index and $lib edges resolve; externals do not", () => {
    expect(
      resolveClientImport(
        "apps/noite/src/pages/storage/x.tsx",
        "../../lib/runner",
        exists
      )
    ).toBe("apps/noite/src/lib/runner.ts");
    expect(
      resolveClientImport("apps/noite/src/lib/runner.ts", "./detail", exists)
    ).toBe("apps/noite/src/lib/detail/index.ts");
    expect(
      resolveClientImport(
        "apps/noite/src/pages/storage/x.tsx",
        "$lib/runner",
        exists
      )
    ).toBe("apps/noite/src/lib/runner.ts");
    expect(
      resolveClientImport(
        "apps/noite/src/pages/storage/x.tsx",
        "effect/Schema",
        exists
      )
    ).toBeNull();
  });
});

describe("checkClientGraph", () => {
  test("the #371 shape fails with the page-to-builtin chain", () => {
    const sources = new Map([
      [
        "apps/noite/src/pages/storage/[appId]/[resource-id].tsx",
        'import { StorageDetail } from "$lib/storage/detail";\n',
      ],
      [
        "apps/noite/src/lib/storage/detail.tsx",
        'import { runnerList } from "$lib/runner";\n',
      ],
      [
        "apps/noite/src/lib/runner.ts",
        'import { withRequestTimeout } from "./request-timeout";\n',
      ],
      [
        "apps/noite/src/lib/request-timeout.ts",
        'import { AsyncLocalStorage } from "node:async_hooks";\n\nconst store = new AsyncLocalStorage();\n',
      ],
      // Server-only backend: only the timeout middleware imports it, and
      // middleware is not a page entry, so it stays out of the graph.
      [
        "apps/noite/src/lib/request-timeout-node.ts",
        'import { AsyncLocalStorage } from "node:async_hooks";\n',
      ],
      [
        "apps/noite/src/middleware/01-timeout.ts",
        'import "../lib/request-timeout-node";\n',
      ],
    ]);

    const violations = checkClientGraph(
      ["apps/noite/src/pages/storage/[appId]/[resource-id].tsx"],
      sources
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("apps/noite/src/lib/request-timeout.ts");
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.specifier).toBe("node:async_hooks");
    expect(violations[0]?.chain).toEqual([
      "apps/noite/src/pages/storage/[appId]/[resource-id].tsx",
      "apps/noite/src/lib/storage/detail.tsx",
      "apps/noite/src/lib/runner.ts",
      "apps/noite/src/lib/request-timeout.ts",
    ]);
  });

  test("the #371 split is clean: the contract loads, the backend is server-only", () => {
    const sources = new Map([
      [
        "apps/noite/src/pages/storage/[appId]/[resource-id].tsx",
        'import { StorageDetail } from "$lib/storage/detail";\n',
      ],
      [
        "apps/noite/src/lib/storage/detail.tsx",
        'import { runnerList } from "$lib/runner";\n',
      ],
      [
        "apps/noite/src/lib/runner.ts",
        'import { withRequestTimeout } from "./request-timeout";\n',
      ],
      [
        "apps/noite/src/lib/request-timeout.ts",
        "export const withRequestTimeout = (s: unknown): unknown => s;\n",
      ],
    ]);

    expect(
      checkClientGraph(
        ["apps/noite/src/pages/storage/[appId]/[resource-id].tsx"],
        sources
      )
    ).toEqual([]);
  });

  test("a bare builtin through a $lib edge fails too", () => {
    const sources = new Map([
      ["apps/noite/src/pages/index.tsx", 'import { hash } from "$lib/hash";\n'],
      ["apps/noite/src/lib/hash.ts", 'import { createHash } from "crypto";\n'],
    ]);

    const violations = checkClientGraph(
      ["apps/noite/src/pages/index.tsx"],
      sources
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("crypto");
  });

  test("an unparseable module fails closed naming the file", () => {
    const sources = new Map([
      ["apps/noite/src/pages/index.tsx", 'import { x } from "$lib/broken";\n'],
      ["apps/noite/src/lib/broken.ts", "const x = {{{;\n"],
    ]);

    expect(() =>
      checkClientGraph(["apps/noite/src/pages/index.tsx"], sources)
    ).toThrow(/apps\/noite\/src\/lib\/broken\.ts/u);
  });
});

describe("requireClientEntries", () => {
  test("an empty page set fails closed instead of passing vacuously", () => {
    // The graph over zero entries reports zero violations, so without this
    // guard the gate would print `clean (0 pages)` with exit 0.
    expect(checkClientGraph([], new Map())).toEqual([]);
    expect(() => requireClientEntries([])).toThrow(/no client pages found/u);
    expect(() =>
      requireClientEntries(["apps/noite/src/pages/index.tsx"])
    ).not.toThrow();
  });
});
