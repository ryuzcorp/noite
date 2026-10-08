import { describe, expect, test } from "bun:test";

import ts from "typescript-ls";

import { defaultCompilerOptions, resolveRepoConfig } from "./ts-config";
import { normalizePath, specMatches, VirtualFs } from "./virtual-fs";

/** A repo-shaped virtual FS: `text` per repository-relative path. */
const repoFs = (files: Record<string, string>): VirtualFs => {
  const fs = new VirtualFs();
  for (const [path, text] of Object.entries(files)) {
    fs.write(`/${path}`, text);
  }
  return fs;
};

const paths = (files: Record<string, string>): string[] =>
  Object.keys(files).map((path) => `/${path}`);

describe("resolveRepoConfig", () => {
  test("falls back to the modern bundler defaults without a tsconfig", () => {
    const files = {
      "README.md": "# hi",
      "node_modules/pkg/index.d.ts": "export declare const x: number;\n",
      "src/main.ts": "export const a = 1;\n",
      "src/util.tsx": "export const B = () => null;\n",
    };
    const config = resolveRepoConfig(repoFs(files), paths(files));
    expect(config.fromTsconfig).toBe(false);
    expect(config.options).toEqual(defaultCompilerOptions());
    expect(config.options.target).toBe(ts.ScriptTarget.ESNext);
    expect(config.options.module).toBe(ts.ModuleKind.ESNext);
    expect(config.options.moduleResolution).toBe(
      ts.ModuleResolutionKind.Bundler
    );
    expect(config.options.jsx).toBe(ts.JsxEmit.ReactJSX);
    expect(config.options.noEmit).toBe(true);
    // Only the repo's own scripts, and `node_modules` never becomes a root.
    expect(config.roots).toEqual(["/src/main.ts", "/src/util.tsx"]);
  });

  test("takes options and roots from the repo's tsconfig", () => {
    const files = {
      "other/extra.ts": "export const c = 3;\n",
      "src/main.ts": "export const a = 1;\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          paths: { "$lib/*": ["./src/lib/*"] },
          strict: false,
          target: "es2022",
        },
        include: ["src"],
      }),
    };
    const config = resolveRepoConfig(repoFs(files), paths(files));
    expect(config.fromTsconfig).toBe(true);
    expect(config.options.target).toBe(ts.ScriptTarget.ES2022);
    expect(config.options.jsx).toBe(ts.JsxEmit.ReactJSX);
    expect(config.options.strict).toBe(false);
    expect(config.options.noEmit).toBe(true);
    expect(config.options.paths).toEqual({ "$lib/*": ["./src/lib/*"] });
    expect(config.options.pathsBasePath).toBe("/");
    // `include` decides: `other/extra.ts` is in the program only once opened.
    expect(config.roots).toEqual(["/src/main.ts"]);
  });

  test("honours exclude patterns", () => {
    const files = {
      "src/generated/api.ts": "export const api = 1;\n",
      "src/main.ts": "export const a = 1;\n",
      "tsconfig.json": JSON.stringify({
        exclude: ["src/generated"],
        include: ["src"],
      }),
    };
    const config = resolveRepoConfig(repoFs(files), paths(files));
    expect(config.roots).toEqual(["/src/main.ts"]);
  });

  test("keeps the fallback options for a tsconfig that does not parse", () => {
    const files = {
      "src/main.ts": "export const a = 1;\n",
      "tsconfig.json": "{ nope",
    };
    const config = resolveRepoConfig(repoFs(files), paths(files));
    // The parser stamps the config's own path onto the options it returns;
    // every actual option stays the fallback.
    expect(config.options).toEqual({
      ...defaultCompilerOptions(),
      configFilePath: "/tsconfig.json",
    });
    expect(config.roots).toEqual(["/src/main.ts"]);
  });

  test("lets the compiler derive module resolution when the config picks a module", () => {
    const files = {
      "src/main.js": "const a = 1;\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "commonjs" },
      }),
    };
    const config = resolveRepoConfig(repoFs(files), paths(files));
    expect(config.options.module).toBe(ts.ModuleKind.CommonJS);
    expect(config.options.moduleResolution).toBeUndefined();
    // The viewer adds JS files even to a TS-only config.
    expect(config.options.allowJs).toBe(true);
    expect(config.roots).toEqual(["/src/main.js"]);
  });

  test("caps the fallback root set", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 420; i += 1) {
      files[`src/file${String(i).padStart(3, "0")}.ts`] = "export {};\n";
    }
    const config = resolveRepoConfig(repoFs(files), paths(files));
    expect(config.roots).toHaveLength(400);
  });
});

describe("virtual fs", () => {
  test("normalizes paths the way TypeScript composes them", () => {
    expect(normalizePath("src/./a.ts")).toBe("/src/a.ts");
    expect(normalizePath("/src//deep/../a.ts")).toBe("/src/a.ts");
    expect(normalizePath("/")).toBe("/");
  });

  test("matches include specs as files, directories or globs", () => {
    expect(specMatches("/src/a.ts", "src")).toBe(true);
    expect(specMatches("/src/a.ts", "/src/a.ts")).toBe(true);
    expect(specMatches("/src/a.ts", "src/*.ts")).toBe(true);
    expect(specMatches("/src/deep/a.ts", "src/*.ts")).toBe(false);
    expect(specMatches("/src/deep/a.ts", "src/**/*.ts")).toBe(true);
    expect(specMatches("/src/a.css", "**/*.ts")).toBe(false);
  });

  test("bumps versions only when the text changes", () => {
    const fs = new VirtualFs();
    fs.write("/a.ts", "one");
    expect(fs.versionOf("/a.ts")).toBe(1);
    fs.write("/a.ts", "one");
    expect(fs.versionOf("/a.ts")).toBe(1);
    fs.write("/a.ts", "two");
    expect(fs.versionOf("/a.ts")).toBe(2);
  });

  test("lists directories and files for the language service host", () => {
    const fs = repoFs({ "src/a.ts": "", "src/deep/b.ts": "", "top.ts": "" });
    expect(fs.getDirectories("/")).toEqual(["src"]);
    expect(fs.getDirectories("/src")).toEqual(["deep"]);
    expect(fs.directoryExists("/src/deep")).toBe(true);
    expect(fs.directoryExists("/nope")).toBe(false);
    expect(fs.readDirectory("/", [".ts"], undefined, [])).toEqual([
      "/src/a.ts",
      "/src/deep/b.ts",
      "/top.ts",
    ]);
  });

  test("clear() keeps only what the predicate selects", () => {
    const fs = repoFs({ "__libs/lib.es5.d.ts": "lib", "src/a.ts": "" });
    fs.clear((path) => path.startsWith("/__libs/"));
    expect(fs.paths()).toEqual(["/__libs/lib.es5.d.ts"]);
    expect(fs.getDirectories("/")).toEqual(["__libs"]);
  });
});
