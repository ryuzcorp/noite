//! What a preview installs before it runs anything. Two rules shape this:
//! the pod's installer is the only way packages get in (its IndexedDB cache
//! is what makes a warm preview milliseconds), and a preview installs what
//! the mode will actually load — a plain Worker's entry graph, not the CLI it
//! keeps in its dependencies. A package the scan misses (a computed dynamic
//! import) fails loudly at request time instead of being guessed at here.

import { projectPath } from "../workspace/types";
import type { WorkspaceFs } from "../workspace/types";
import { HARNESS_DIR, HARNESS_MANIFEST } from "./harness";
import type { PreviewLogStream, PreviewPod } from "./types";

/** The version of `srvx` a preview runs: the one the feasibility runs
 * verified against this pod's HTTP polyfill. */
export const SRVX_VERSION = "1.0.5";

/** How many files the entry-graph scan reads before it stops. */
const MAX_SCANNED_FILES = 400;

/** The extensions a relative import may omit. */
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".mts"] as const;

/** Modules the pod provides itself; a bare `fs` is not an npm install. */
const BUILTINS = {
  assert: true,
  buffer: true,
  child_process: true,
  cluster: true,
  console: true,
  crypto: true,
  dgram: true,
  diagnostics_channel: true,
  dns: true,
  events: true,
  fs: true,
  http: true,
  http2: true,
  https: true,
  module: true,
  net: true,
  os: true,
  path: true,
  perf_hooks: true,
  process: true,
  punycode: true,
  querystring: true,
  readline: true,
  sqlite: true,
  stream: true,
  string_decoder: true,
  timers: true,
  tls: true,
  trace_events: true,
  tty: true,
  url: true,
  util: true,
  v8: true,
  vm: true,
  wasi: true,
  worker_threads: true,
  zlib: true,
} satisfies Record<string, true>;

/** An npm package name, with or without a scope. An alias (`@/lib/x`, `~/x`)
 * has no valid scope or name and is refused here. */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/iu;

/** Everything a module specifier can be, as the scan finds it: a `from "…"`,
 * a side-effect `import "…"`, and a literal `import("…")`. */
const SPECIFIERS = [
  /\bfrom\s*["'](?<specifier>[^"']+)["']/gu,
  /\bimport\s*["'](?<specifier>[^"']+)["']/gu,
  /\bimport\s*\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu,
] as const;

export interface InstallRun {
  onLog: (line: string, stream: PreviewLogStream) => void;
}

/** Type-only imports and re-exports (`import type …`, `export type …`) are
 * erased before the pod ever runs the module, so the packages they name are
 * not installed: a `cf` config a Worker only consults for its `Env` type must
 * not pull the whole CLI in. */
const withoutTypeImports = (source: string): string =>
  source.replaceAll(
    /\b(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["']/gu,
    ""
  );

const specifiersOf = (source: string): string[] => {
  const found: string[] = [];
  for (const pattern of SPECIFIERS) {
    for (const match of withoutTypeImports(source).matchAll(pattern)) {
      const specifier = match.groups?.specifier;
      if (specifier !== undefined) {
        found.push(specifier);
      }
    }
  }
  return found;
};

/** The npm package a specifier names, or null when it names something else
 * (a relative path, a path alias, a builtin). */
export const packageOf = (specifier: string): string | null => {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  const segments = specifier.split("/");
  const [first] = segments;
  const name = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : first;
  if (!PACKAGE_NAME.test(name) || Object.hasOwn(BUILTINS, name)) {
    return null;
  }
  return name;
};

/** The path a relative specifier names, trying the extensions a bundler
 * would try. `null` when nothing under the importer holds it. */
const resolveRelative = async (
  fs: WorkspaceFs,
  fromDir: string,
  specifier: string
): Promise<string | null> => {
  const base = `${fromDir}/${specifier.replace(/^\.\//u, "")}`;
  for (const candidate of [
    base,
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the candidates are probed in bundler order: the first one that exists wins, so they cannot be checked in parallel
    if (await fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
};

/** A tsconfig's `compilerOptions`; only `paths` matters to the scan. */
interface TsConfigCompilerOptions {
  paths?: Record<string, string[]>;
}

/** The tsconfig shape the aliases are read from. */
interface TsConfigPaths {
  compilerOptions?: TsConfigCompilerOptions;
}

const isText = (value: unknown): value is string => typeof value === "string";

/** Whether every entry in `value` is one of an alias's target patterns. */
const isPatternList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);

/** Whether `value` is an alias-to-patterns map. */
const isPathMap = (value: unknown): value is Record<string, string[]> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).every(isPatternList);
};

/** Whether `value` is `compilerOptions`, whose `paths` may be absent. */
const isCompilerOptions = (
  value: unknown
): value is TsConfigCompilerOptions => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return !("paths" in value) || isPathMap(value.paths);
};

/** Whether `value` is a tsconfig, whose `compilerOptions` may be absent. */
const isTsConfigPaths = (value: unknown): value is TsConfigPaths =>
  typeof value === "object" &&
  value !== null &&
  (!("compilerOptions" in value) || isCompilerOptions(value.compilerOptions));

/** The path aliases a repo's tsconfig declares (`paths` keys, minus the
 * `/*`). A bare specifier that matches one is the repo's own module, not a
 * package to install. */
export const pathAliases = async (fs: WorkspaceFs): Promise<string[]> => {
  const path = "/home/project/tsconfig.json";
  if (!(await fs.exists(path))) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    return [];
  }
  if (!isTsConfigPaths(parsed)) {
    return [];
  }
  const paths = parsed.compilerOptions?.paths ?? {};
  return Object.keys(paths)
    .map((alias) => alias.replace(/\/\*$/u, ""))
    .filter((alias) => alias !== "");
};

const isAliased = (specifier: string, aliases: readonly string[]): boolean =>
  aliases.some(
    (alias) => specifier === alias || specifier.startsWith(`${alias}/`)
  );

/** Every npm package `entry` loads: the static and dynamic imports of the
 * entry's own module graph, walked with the same extension guesses a bundler
 * makes. `tsconfig` path aliases are skipped; so is everything the pod
 * provides. */
export const entryPackages = async (
  fs: WorkspaceFs,
  entry: string,
  aliases: readonly string[]
): Promise<string[]> => {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  let cursor = 0;
  while (cursor < queue.length && seen.size < MAX_SCANNED_FILES) {
    const path = queue[cursor];
    cursor += 1;
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    let source: string;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the queue grows from what each file imports, so the next file is not known until this one is read
      source = await fs.readFile(path, "utf-8");
    } catch {
      continue;
    }
    const dir = path.slice(0, path.lastIndexOf("/"));
    for (const specifier of specifiersOf(source)) {
      const name = packageOf(specifier);
      if (name !== null) {
        if (!isAliased(specifier, aliases)) {
          packages.add(name);
        }
        continue;
      }
      if (!specifier.startsWith(".")) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- one specifier's extension guesses are probed in order, and only the first hit is queued
      const resolved = await resolveRelative(fs, dir, specifier);
      if (resolved !== null) {
        queue.push(resolved);
      }
    }
  }
  return [...packages].toSorted((left, right) => (left < right ? -1 : 1));
};

/** The checkout's npm lockfile, which the pod's installer rewrites after every
 * install whatever the flags say. */
const APP_LOCKFILE = projectPath("package-lock.json");

/** Run an install into the checkout and put its `package-lock.json` back the
 * way it was — the same bytes, or absent — so a preview never shows up as a
 * change to push (the same rule `persist: false` keeps for `package.json`). */
const keepingLockfile = async (
  fs: WorkspaceFs,
  install: () => Promise<void>
): Promise<void> => {
  const before = (await fs.exists(APP_LOCKFILE))
    ? await fs.readFile(APP_LOCKFILE)
    : null;
  try {
    await install();
  } finally {
    await (before === null
      ? fs.rm(APP_LOCKFILE, { force: true })
      : fs.writeFile(APP_LOCKFILE, before));
  }
};
/** Install one manifest, with or without its devDependencies. */
export const installManifest = async (
  pod: PreviewPod,
  options: {
    manifest: string;
    run: InstallRun;
    withDevDeps: boolean;
  }
): Promise<void> => {
  const { manifest, run, withDevDeps } = options;
  run.onLog(
    `preview: installing ${manifest}${withDevDeps ? " (with devDependencies)" : ""}`,
    "system"
  );
  await keepingLockfile(pod.fs, async () => {
    await pod.packages.installFromManifest(manifest, {
      onProgress: (message) => run.onLog(message, "system"),
      persist: false,
      withDevDeps,
    });
  });
  run.onLog(
    `preview: ${Object.keys(pod.packages.listInstalled()).length} packages installed`,
    "system"
  );
};

/** Install packages one by one, and answer with the ones that failed: a
 * package the registry does not have is worth a log line, not a dead
 * preview. */
export const installPackages = async (
  pod: PreviewPod,
  specs: readonly { name: string; version?: string }[],
  run: InstallRun
): Promise<string[]> => {
  const failures: string[] = [];
  for (const spec of specs) {
    const label =
      spec.version === undefined ? spec.name : `${spec.name}@${spec.version}`;
    run.onLog(`preview: installing ${label}`, "system");
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- installs run one at a time: each prints its progress in order and shares the pod's installer
      await keepingLockfile(pod.fs, async () => {
        await pod.packages.install(spec.name, spec.version, {
          onProgress: (message) => run.onLog(message, "system"),
          persist: false,
        });
      });
    } catch (error) {
      failures.push(label);
      run.onLog(
        `preview: could not install ${label}: ${error instanceof Error ? error.message : String(error)}`,
        "system"
      );
    }
  }
  return failures;
};

/** Install the preview's own tooling (`srvx`, and `vite` for a build) into
 * the harness directory beside the generated server, never into the app:
 * the app's `package.json` and `node_modules` stay exactly what the app
 * declares, and the server resolves `srvx` from its own `node_modules`.
 * Answers with the path the tooling's packages landed in. */
export const installTooling = async (
  pod: PreviewPod,
  dependencies: Readonly<Record<string, string>>,
  run: InstallRun
): Promise<string> => {
  const labels = Object.entries(dependencies).map(
    ([name, version]) => `${name}@${version}`
  );
  run.onLog(
    `preview: installing ${labels.join(", ")} for the preview`,
    "system"
  );
  await pod.fs.mkdir(HARNESS_DIR, { recursive: true });
  await pod.fs.writeFile(
    HARNESS_MANIFEST,
    `${JSON.stringify({ dependencies, name: "noite-preview", private: true, type: "module" }, null, 2)}\n`
  );
  const child = await pod.spawn(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-package-lock"],
    { cwd: HARNESS_DIR }
  );
  child.on("output", (chunk) => run.onLog(chunk.trimEnd(), "system"));
  child.on("error", (chunk) => run.onLog(chunk.trimEnd(), "stderr"));
  const { exitCode } = await child.completion;
  if (exitCode !== 0) {
    throw new Error(
      `preview: could not install ${labels.join(", ")} (npm exited with ${exitCode})`
    );
  }
  return `${HARNESS_DIR}/node_modules`;
};
