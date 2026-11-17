import { describe, expect, test } from "bun:test";

import {
  checkBuiltClient,
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

describe("checkBuiltClient", () => {
  // Verbatim vite 8.3.8 client output for a bundled `node:fs`: the `node:fs`
  // specifier is gone (only the accessed property survives), replaced by
  // the inlined stub factory. Re-capture from a real build when Vite bumps.
  const stubbed =
    'import{t as e}from"./rolldown-runtime-XKyaHtl9.js";(0,e(((e,t)=>{t.exports={}}))().readFileSync)(`/etc/hostname`,`utf-8`).length;';

  const clean =
    'import{t as e}from"./dates-abc.js";var t=new Intl.DateTimeFormat(void 0,{day:`numeric`});';

  const bundledCjs = 'var x=__commonJS({"dep.js":(e,t)=>{e.exports=r;}});';

  test("a stubbed builtin chunk fails with its chunk path", () => {
    expect(
      checkBuiltClient(
        new Map([["apps/noite/dist/client/assets/dates-x.js", stubbed]])
      )
    ).toEqual([{ file: "apps/noite/dist/client/assets/dates-x.js" }]);
  });

  test("clean chunks, sourcemaps and bundled CJS pass", () => {
    expect(
      checkBuiltClient(
        new Map([
          ["apps/noite/dist/client/assets/dates-abc.js", clean],
          // Sourcemaps carry the original specifiers in sourcesContent —
          // never scanned (`.js` only).
          [
            "apps/noite/dist/client/assets/dates-abc.js.map",
            '{"sourcesContent":["import { x } from \\"node:fs\\";"]}',
          ],
          // A real bundled CJS module assigns `.exports`, but never as a
          // lone `{}` factory passed to the interop helper.
          ["apps/noite/dist/client/assets/dep-y.js", bundledCjs],
        ])
      )
    ).toEqual([]);
  });

  test("a builtin through a dependency fails: the source walk is blind to it", () => {
    // SecRev50's shape: the page reaches a package, the package reaches
    // `node:fs`. The source walk drops the bare specifier, so it reports
    // clean — the dist scan is the layer that sees the stub.
    const sources = new Map([
      ["apps/noite/src/pages/index.tsx", 'import { x } from "probe-dep";\n'],
    ]);

    expect(
      checkClientGraph(["apps/noite/src/pages/index.tsx"], sources)
    ).toEqual([]);
    expect(
      checkBuiltClient(
        new Map([["apps/noite/dist/client/assets/index-z.js", stubbed]])
      )
    ).toEqual([{ file: "apps/noite/dist/client/assets/index-z.js" }]);
  });
});
