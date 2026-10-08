//! Compiler options for the repository the browser is looking at.
//!
//! The editor must type-check a tenant repo the same way its own `tsc` would,
//! so `tsconfig.json` is parsed over the worker's virtual FS (the repo's text
//! sources captured by `source.bundle`), through TypeScript's own
//! `parseJsonConfigFileContent`: that is the only way to get `extends`, `paths`,
//! `include`/`exclude` and every option alias right.
//!
//! Two things the config cannot decide are overridden: the program never emits
//! (`noEmit`), and JS files are always part of it (`allowJs` — a viewer that
//! dropped the repo's `.js` files would refuse to answer for them).
//!
//! When there is no usable config the defaults below are the whole answer: the
//! modern bundler setup (ESNext target, `bundler` resolution, `react-jsx`) that
//! every Vite/Next/TanStack app shares.

import ts from "typescript-ls";

import { isScriptFile } from "./intel-protocol";
import type { VirtualFs } from "./virtual-fs";

/** Where the repo's config lives in the virtual FS (the tree root). */
const CONFIG_PATH = "/tsconfig.json";

/** Above this many roots, the fallback scopes the program to the files the
 * editor opens: a whole-repo program of thousands of files takes seconds to
 * check, and the browser's job is the file on screen, not the build. */
const ROOT_FILE_LIMIT = 400;

/** `node_modules` is never a program root (declarations come in through module
 * resolution, not as roots). */
const NODE_MODULES = "/node_modules/";

export interface RepoConfig {
  /** Options for the language service program (never emits). */
  options: ts.CompilerOptions;
  /** Program roots: repository-relative script paths, `/`-rooted. */
  roots: string[];
  /** Whether `/tsconfig.json` was found and parsed (vs. the fallback). */
  fromTsconfig: boolean;
}

/** What a repo gets without a config: the shared modern-app baseline.
 * `checkJs` stays off — a fallback has no project intent behind it, and
 * checking untyped JS under `strict` would drown those files in red. */
export const defaultCompilerOptions = (): ts.CompilerOptions => ({
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ESNext,
});

/** Every script file the repo ships, capped — the fallback root set. */
const fallbackRoots = (repoPaths: readonly string[]): string[] =>
  repoPaths
    .filter((path) => isScriptFile(path) && !path.startsWith(NODE_MODULES))
    .toSorted()
    .slice(0, ROOT_FILE_LIMIT);

/** Parse `/tsconfig.json` over the virtual FS; `undefined` when it is not
 * parseable at all (invalid JSON, or a throw from a pathological `extends`). */
const parseConfig = (
  fs: VirtualFs,
  text: string
): ts.ParsedCommandLine | undefined => {
  try {
    return ts.parseJsonSourceFileConfigFileContent(
      ts.parseJsonText(CONFIG_PATH, text),
      {
        fileExists: fs.fileExists,
        readDirectory: fs.readDirectory,
        readFile: fs.readFile,
        useCaseSensitiveFileNames: true,
      },
      "/",
      {},
      CONFIG_PATH
    );
  } catch {
    return undefined;
  }
};

/** The options and roots for a program over `fs`.
 *
 * `parsed.errors` is deliberately ignored: a repo may extend a config we
 * cannot see (a package's tsconfig lives in `node_modules`, and only its
 * *declarations* were captured from the build), and the options that did parse
 * still beat guessing. */
export const resolveRepoConfig = (
  fs: VirtualFs,
  repoPaths: readonly string[]
): RepoConfig => {
  const known = new Set(repoPaths);
  const roots = fallbackRoots(repoPaths);
  const text = fs.read(CONFIG_PATH);
  if (text === undefined) {
    return { fromTsconfig: false, options: defaultCompilerOptions(), roots };
  }
  const parsed = parseConfig(fs, text);
  if (!parsed) {
    return { fromTsconfig: false, options: defaultCompilerOptions(), roots };
  }
  const merged: ts.CompilerOptions = {
    ...defaultCompilerOptions(),
    ...parsed.options,
    allowJs: true,
    noEmit: true,
  };
  if (
    parsed.options.module !== undefined &&
    parsed.options.moduleResolution === undefined
  ) {
    // The config picked a module system but no resolver. Our `bundler` default
    // is invalid next to, say, `commonjs`, so let the compiler derive it.
    merged.moduleResolution = undefined;
  }
  const declared = parsed.fileNames.filter(
    (path) => known.has(path) && isScriptFile(path)
  );
  return {
    fromTsconfig: true,
    options: merged,
    roots:
      declared.length > 0 && declared.length <= ROOT_FILE_LIMIT
        ? declared
        : roots,
  };
};
