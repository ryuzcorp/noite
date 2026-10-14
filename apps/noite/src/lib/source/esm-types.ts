//! Package type declarations from esm.sh — the pure half.
//!
//! The language-service worker resolves a repo's bare imports against the
//! packages that repo depends on. There is no `node_modules` to read: the
//! declarations are fetched from esm.sh by the worker itself (`esm-fetch.ts`),
//! at the exact version the repo's lockfile pins. This module is the part of
//! that with neither network nor compiler in it — package specifiers, lockfile
//! versions, URL ↔ virtual-path mapping, and the candidate URLs a fetched
//! declaration's own imports point at — so it can be unit-tested against
//! recorded responses.
//!
//! Nothing here may import `typescript-ls` (that would put the compiler in the
//! main bundle) or touch the DOM.

/** esm.sh, the one origin package declarations come from. */
export const ESM_ORIGIN = "https://esm.sh";

/** Where fetched declarations live in the worker's virtual FS. A directory of
 * its own, so no repository file can shadow them and the tree never shows
 * them. */
export const ESM_TYPES_DIR = "/__esm";

/** One acquisition's caps: files kept, one file, the whole payload. A real
 * declaration graph is a few dozen small files (`@cloudflare/workers-types` is
 * one 600 KiB file), but a big app's whole dependency graph — Vite, wrangler,
 * effect, a UI kit — is a thousand files and tens of megabytes, so these caps
 * are sized for the largest real graph: they stop a pathological one from
 * filling the worker, not a real one. */
export const MAX_TYPES_FILES = 2000;
export const MAX_TYPES_FILE = 8 * 1024 * 1024;
export const MAX_TYPES_BYTES = 48 * 1024 * 1024;

/** Concurrent fetches: enough to hide the round trips — a declaration graph is
 * discovered in waves (a file, then what it imports), and the entry probes are
 * alternatives that must overlap — while staying far below the point where a
 * big graph opens hundreds of connections at once. */
export const FETCH_CONCURRENCY = 12;

/** Where a negative result lives: a URL that answered nothing usable. Kept
 * apart from the declaration cache so a miss can never be mistaken for the
 * file. */
export const MISS_CACHE_NAME = "noite-esm-misses";

/** The header an entry in that cache carries: the epoch-ms its miss goes
 * stale. esm.sh's versioned URLs are immutable — a 404 stays a 404 — but a
 * 500 is esm.sh failing to *build* a package, which the next deploy of esm.sh
 * may well fix, so the two get different lifetimes. */
export const MISS_EXPIRY_HEADER = "x-noite-miss-expiry";
export const MISS_TTL_MISSING_MS = 7 * 24 * 60 * 60 * 1000;
export const MISS_TTL_BUILD_MS = 60 * 60 * 1000;

/** When a negative result recorded at `now` stops being trusted: a URL esm.sh
 * answered 4xx for does not come into existence, while a 5xx is esm.sh failing
 * to build the package, which a later esm.sh deploy may fix. */
export const missExpiry = (status: number, now: number): number =>
  now +
  (status >= 400 && status < 500 ? MISS_TTL_MISSING_MS : MISS_TTL_BUILD_MS);

/** Code extensions, `d.ts` families included: the only subpaths whose module
 * URL could serve a declaration. `pkg/package.json`, `pkg/style.css`,
 * `pkg/logo.svg` name files esm.sh serves verbatim — probing them is a round
 * trip that always ends in "unresolved". */
const CODE_EXTENSION = /^\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/u;

/** Whether a package subpath names code. An extensionless subpath
 * (`cf/config`) is a module path esm.sh resolves like a bundler would; a
 * dotted one — `.env` included — has to end in a script extension. */
export const isCodeSubpath = (subpath: string): boolean => {
  if (subpath === "") {
    return true;
  }
  const name = subpath.slice(subpath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return true;
  }
  return CODE_EXTENSION.test(name.slice(dot).toLowerCase());
};

/** A bare specifier split into the package it names and its subpath
 * (`cf/config` → `cf` + `config`; `@scope/pkg/sub` → `@scope/pkg` + `sub`). */
export interface PackageSpecifier {
  name: string;
  subpath: string;
}

/** Files the compiler type-checks JSX in — the only ones it resolves a JSX
 * runtime for. A pragma in a `.ts` file is inert (JSX is not syntax there). */
const JSX_FILE = /\.(?:jsx|tsx)$/u;

/** How the config compiles JSX. Only the two `react-jsx` modes resolve a
 * runtime module: `preserve` emits the JSX as written and `classic` calls a
 * factory identifier, so neither asks esm.sh for anything. */
export type JsxMode = "classic" | "preserve" | "react-jsx" | "react-jsxdev";

/** The `@jsxImportSource` a file's own pragma names — the per-file override of
 * the `jsxImportSource` option, which TypeScript honours wherever the file
 * carries it. */
export const jsxImportSourceOf = (text: string): string | undefined =>
  /@jsxImportSource\s+(?<source>[\w@/.-]+)/u.exec(text)?.groups?.source;

/** The JSX runtime specifiers one file makes the compiler resolve:
 * `<jsxImportSource>/jsx-runtime`, plus `/jsx-dev-runtime` in a development
 * build. They are implicit imports — nothing in the file writes them — so
 * without them every JSX element reports TS2875/TS7026. The file's own pragma
 * wins over the configured `importSource`, and the configured one falls back
 * to `react` exactly as the compiler does. */
export const jsxRuntimeSpecifiers = (input: {
  file: string;
  importSource: string | undefined;
  mode: JsxMode;
  text: string;
}): string[] => {
  if (
    (input.mode !== "react-jsx" && input.mode !== "react-jsxdev") ||
    !JSX_FILE.test(input.file)
  ) {
    return [];
  }
  const source = jsxImportSourceOf(input.text) ?? input.importSource ?? "react";
  return input.mode === "react-jsxdev"
    ? [`${source}/jsx-runtime`, `${source}/jsx-dev-runtime`]
    : [`${source}/jsx-runtime`];
};

/** A URL scheme (`node:fs`, `cloudflare:pipelines`, `data:…`, `http:`): never
 * a package, and never ours to resolve. */
const SCHEME = /^[a-z][a-z\d+.-]*:/iu;

/** Split a bare specifier into its package and subpath; null when it is not a
 * package at all — a relative or absolute path, or a URL scheme — which keeps
 * resolving exactly as it did before esm.sh entered the picture. */
export const parsePackageSpecifier = (
  specifier: string
): PackageSpecifier | null => {
  if (
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    SCHEME.test(specifier)
  ) {
    return null;
  }
  const segments = specifier.split("/");
  const scoped = specifier.startsWith("@");
  if (scoped && segments.length < 2) {
    return null;
  }
  const name = scoped ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
  if (name === "") {
    return null;
  }
  return { name, subpath: specifier.slice(name.length).replace(/^\//u, "") };
};

/** The esm.sh module URL for a package at a version, its subpath included —
 * `https://esm.sh/cf@1.0.0-beta.10/config`. esm.sh resolves a range the way
 * npm would, so a `package.json` range is a valid version here. */
export const esmModuleUrl = (
  specifier: PackageSpecifier,
  version: string
): string =>
  `${ESM_ORIGIN}/${specifier.name}@${version}${
    specifier.subpath === "" ? "" : `/${specifier.subpath}`
  }`;

/** A URL without its query or fragment: the identity of a fetched declaration.
 * `?raw` (esm.sh's escape hatch that serves a package's file as-is) is the same
 * file as the transformed URL, so both have to land on one virtual path. */
export const canonicalUrl = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

/** Where a fetched declaration lives in the virtual FS: its URL's host and
 * path under `/__esm`. */
export const typesVirtualPath = (url: string): string => {
  const parsed = new URL(url);
  return `${ESM_TYPES_DIR}/${parsed.host}${parsed.pathname}`;
};

/** The URL a virtual path was fetched from (only esm.sh is ever fetched, so
 * the scheme is fixed). */
export const typesUrlOfPath = (path: string): string =>
  `https://${path.slice(ESM_TYPES_DIR.length + 1)}`;

/** Declaration files: analysable, and never re-fetched as anything else. */
const DECLARATION_EXT = /\.d\.[cm]?ts$/u;

/** The declaration a source extension stands for, in a declaration's own
 * import: TypeScript maps `./x.mjs` to the `x.d.mts` beside it, `./x.js` to
 * `x.d.ts`, and so on. A raw declaration keeps its original specifiers, so
 * these substitutions are live, not hypothetical. */
const declarationOfExt = (extension: string): string | undefined => {
  switch (extension) {
    case ".cjs":
    case ".cts": {
      return ".d.cts";
    }
    case ".js":
    case ".jsx":
    case ".ts":
    case ".tsx": {
      return ".d.ts";
    }
    case ".mjs":
    case ".mts": {
      return ".d.mts";
    }
    default: {
      return undefined;
    }
  }
};

/** The candidate URLs `specifier`, read from the declaration at `containing`,
 * points at — best first. An absolute esm.sh URL (what a transformed
 * declaration carries) is its own only candidate; a relative one is resolved
 * and its extension substituted; an extensionless one may be the file or a
 * directory's `index`. */
export const declarationTargets = (
  specifier: string,
  containing: string
): string[] => {
  const { origin, pathname: path } = new URL(specifier, containing);
  if (DECLARATION_EXT.test(path)) {
    return [`${origin}${path}`];
  }
  const dot = path.lastIndexOf(".");
  const extension =
    dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
  const swapped = declarationOfExt(extension);
  if (swapped !== undefined) {
    return [`${origin}${path.slice(0, dot)}${swapped}`];
  }
  const base = `${origin}${path}`;
  return [
    `${base}.d.ts`,
    `${base}.d.mts`,
    `${base}/index.d.ts`,
    `${base}/index.d.mts`,
  ];
};

/** What to probe when the `X-TypeScript-Types` header gave nothing: a package's
 * published declaration files at the conventional paths. esm.sh answers 500 for
 * a types-only package (`@cloudflare/workers-types` ships no JavaScript at all)
 * and for a few packages esbuild refuses, and it strips `types` out of the
 * `package.json` it serves, so the header is the only discovery route — and
 * `Access-Control-Expose-Headers` is not always on the response esm.sh serves
 * from its CDN, which a worker's CORS fetch must have to read it. `?raw` is the
 * documented escape hatch that serves any file a package ships. */
export const entryTypeCandidates = (moduleUrl: string): string[] => [
  `${moduleUrl}.d.ts`,
  `${moduleUrl}.d.mts`,
  `${moduleUrl}/index.d.ts`,
  `${moduleUrl}/index.d.mts`,
  `${moduleUrl}/dist/index.d.ts`,
  `${moduleUrl}/dist/index.d.mts`,
];

/** Package name → the version to ask esm.sh for. */
export type PackageVersions = ReadonlyMap<string, string>;

/** `name@version` → its two halves, split at the last `@` (a scope's own `@`
 * is never the last one in a scoped specifier). */
const splitNameVersion = (
  spec: string
): { name: string; version: string } | undefined => {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    return undefined;
  }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
};

/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- the lockfile boundary: a repo's own lockfile is JSON whose package names are its keys, so its shape is an open dictionary and this is the one place that takes it apart. Every field is checked here before it is read, and nothing untyped leaves this section. */

/** Parse JSON that may carry trailing commas (`bun.lock` is JSONC). */
const parseJsonc = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    try {
      // Trailing commas are the only JSONC allowance bun's lockfile uses.
      return JSON.parse(text.replaceAll(/,(?=\s*[}\]])/gu, ""));
    } catch {
      return undefined;
    }
  }
};

/** The lockfile shapes, as much of them as this module consumes. */
interface BunLock {
  packages?: Record<string, unknown>;
}

interface PackageLockEntry {
  dependencies?: Record<string, PackageLockEntry>;
  version?: unknown;
}

interface PackageLock {
  dependencies?: Record<string, PackageLockEntry>;
  packages?: Record<string, PackageLockEntry>;
}

interface Manifest {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

/** `bun.lock`: `packages` maps a name to `["name@version", …]`. */
export const parseBunLock = (text: string): Map<string, string> => {
  const versions = new Map<string, string>();
  const lock = parseJsonc(text);
  if (typeof lock !== "object" || lock === null) {
    return versions;
  }
  const { packages } = lock as BunLock;
  if (typeof packages !== "object" || packages === null) {
    return versions;
  }
  for (const entry of Object.values(packages)) {
    // Only the first element is read: `["name@version", …]`.
    const first = Array.isArray(entry) ? (entry as unknown[])[0] : undefined;
    if (typeof first !== "string") {
      continue;
    }
    const split = splitNameVersion(first);
    if (split) {
      versions.set(split.name, split.version);
    }
  }
  return versions;
};

/** `package-lock.json` (v2/v3 `packages`, v1 nested `dependencies`). */
export const parsePackageLock = (text: string): Map<string, string> => {
  const versions = new Map<string, string>();
  const parsed = parseJsonc(text);
  if (typeof parsed !== "object" || parsed === null) {
    return versions;
  }
  const lock = parsed as PackageLock;
  if (lock.packages !== undefined) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      const at = path.lastIndexOf("node_modules/");
      if (typeof entry.version !== "string" || at === -1) {
        continue;
      }
      const name = path.slice(at + "node_modules/".length);
      if (name !== "") {
        versions.set(name, entry.version);
      }
    }
  }
  const walk = (dependencies: Record<string, PackageLockEntry>): void => {
    for (const [name, entry] of Object.entries(dependencies)) {
      if (typeof entry.version === "string") {
        versions.set(name, entry.version);
      }
      if (entry.dependencies !== undefined) {
        walk(entry.dependencies);
      }
    }
  };
  if (lock.dependencies !== undefined) {
    walk(lock.dependencies);
  }
  return versions;
};

/** `pnpm-lock.yaml`: the `packages:` keys, `/name@version` with an optional
 * peer suffix (`_peer@x` / `(peer@x)`). Read line by line — a YAML parser for
 * one section of one file would be more code than the file is worth. */
export const parsePnpmLock = (text: string): Map<string, string> => {
  const versions = new Map<string, string>();
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (line !== "" && !/^\s/u.test(line)) {
      inPackages = line.startsWith("packages:");
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const key = /^ {2,}(?<quote>["']?)(?<key>[^\s:'"]+)\k<quote>:\s*$/u.exec(
      line
    )?.groups?.key;
    if (key === undefined) {
      continue;
    }
    const bare = key.startsWith("/") ? key.slice(1) : key;
    const at = bare.startsWith("@")
      ? bare.indexOf("@", bare.indexOf("/") + 1)
      : bare.indexOf("@");
    if (at <= 0) {
      continue;
    }
    const version = bare.slice(at + 1).replace(/[(_].*$/u, "");
    if (version !== "") {
      versions.set(bare.slice(0, at), version);
    }
  }
  return versions;
};

/** `yarn.lock`: a header line of `name@range` keys, then the resolved
 * `version "x"` under it. */
export const parseYarnLock = (text: string): Map<string, string> => {
  const versions = new Map<string, string>();
  let keys: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    if (!/^\s/u.test(line)) {
      keys = line
        .replace(/:$/u, "")
        .split(",")
        .map((key) => key.trim().replaceAll(/^"|"$/gu, ""));
      continue;
    }
    const version = /^\s+version\s+"(?<version>[^"]+)"/u.exec(line)?.groups
      ?.version;
    if (version === undefined) {
      continue;
    }
    for (const key of keys) {
      const split = splitNameVersion(key);
      if (split) {
        versions.set(split.name, version);
      }
    }
    keys = [];
  }
  return versions;
};

/** A dependency range we can hand to esm.sh. `workspace:*`, `file:`, `link:`,
 * `git+…`, a URL or an alias names something esm.sh cannot serve. */
const USABLE_RANGE = /^[\^~>=<\d]|^(?:alpha|beta|canary|latest|next|rc)$/u;

/** The `dependencies`-shaped fields of a `package.json`. */
const MANIFEST_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Every dependency range one `package.json` declares, as name → range. */
const packageJsonRanges = (text: string): Map<string, string> => {
  const ranges = new Map<string, string>();
  const parsed = parseJsonc(text);
  if (typeof parsed !== "object" || parsed === null) {
    return ranges;
  }
  const manifest = parsed as Manifest;
  for (const field of MANIFEST_FIELDS) {
    const block = manifest[field];
    if (block === undefined) {
      continue;
    }
    for (const [name, range] of Object.entries(block)) {
      if (typeof range === "string" && USABLE_RANGE.test(range)) {
        ranges.set(name, range);
      }
    }
  }
  return ranges;
};

/* oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */

/** Which reader reads which lockfile, and the order a repo is asked about
 * them: a repo has one, and the first that exists is the one that pinned its
 * install. */
const LOCKFILE_READERS: readonly (readonly [
  string,
  (text: string) => Map<string, string>,
])[] = [
  ["bun.lock", parseBunLock],
  ["package-lock.json", parsePackageLock],
  ["pnpm-lock.yaml", parsePnpmLock],
  ["yarn.lock", parseYarnLock],
];

/** The versions one repo pins: its lockfile's exact versions first, then the
 * ranges of its `package.json` files for whatever the lockfile does not name
 * (or for a repo with no lockfile at all — esm.sh resolves a range itself).
 * The shallowest manifest is read first, so a workspace's root wins over a
 * package's. */
export const collectVersions = (
  files: readonly { path: string; text: string }[]
): Map<string, string> => {
  const versions = new Map<string, string>();
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  for (const [name, read] of LOCKFILE_READERS) {
    const text = byPath.get(name);
    if (text === undefined) {
      continue;
    }
    for (const [pkg, version] of read(text)) {
      versions.set(pkg, version);
    }
    break;
  }
  const manifests = files
    .filter(
      (file) =>
        file.path === "package.json" || file.path.endsWith("/package.json")
    )
    .toSorted((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const manifest of manifests) {
    for (const [name, range] of packageJsonRanges(manifest.text)) {
      if (!versions.has(name)) {
        versions.set(name, range);
      }
    }
  }
  return versions;
};
