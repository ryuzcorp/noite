//! The worker's tiny file system: repository-relative paths → text, with just
//! enough directory bookkeeping for TypeScript (parse hosts, module
//! resolution and `@types` scanning ask for files, directories and directory
//! listings — never for anything else).
//!
//! Paths are rooted at `/` (`/src/main.ts`, `/node_modules/react/index.d.ts`)
//! because that is the shape the language service expects from its host:
//! `getCurrentDirectory()` is `/` and every file name it produces is absolute.
//!
//! Pure and dependency-free on purpose (no `typescript-ls` here), so the
//! include/exclude matching and the path normalization are unit-testable.

/** Files are written as text; the version bumps only when the text changes,
 * which is what tells TypeScript to re-parse (and what it does not). */
interface VirtualEntry {
  text: string;
  version: number;
}

/** Collapse `//`, `.` and `..` segments. TypeScript hands the host normalized
 * paths, but module resolution composes its own, so normalize defensively. */
export const normalizePath = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

/** The regex source for one glob token: `**` crosses segments, `*` and `?`
 * stay inside one; anything else is escaped by the caller. A function, not a
 * lookup table: the order these are matched in is part of the meaning, and a
 * formatter may not reorder it. */
const globPiece = (token: string): string | undefined => {
  if (token === "**/") {
    return "(?:.*/)?";
  }
  if (token === "**") {
    return ".*";
  }
  if (token === "*") {
    return "[^/]*";
  }
  if (token === "?") {
    return "[^/]";
  }
  return undefined;
};

/** Every piece that matters in a spec: the glob syntax above, or a regex
 * metacharacter to escape. */
const GLOB_TOKEN = /\\|\*\*\/|\*\*|\*|\?|[.+^${}()|[\]]/gu;

/** Whether a `tsconfig` include/exclude spec covers `path`. Specs are matched
 * the way TypeScript means them: a bare directory covers everything below it,
 * a bare file must name the file, and `*` / `?` / `**` glob within the spec's
 * segments (`**` crossing them). */
export const specMatches = (path: string, spec: string): boolean => {
  const target = normalizePath(spec);
  if (!/[?*]/u.test(target)) {
    return path === target || path.startsWith(`${target}/`);
  }
  // One pass: a second one would rewrite the wildcards the first produced.
  const pattern = target.replaceAll(
    GLOB_TOKEN,
    (token) => globPiece(token) ?? `\\${token}`
  );
  return new RegExp(`^${pattern}$`, "u").test(path);
};

export class VirtualFs {
  readonly useCaseSensitiveFileNames = true;
  #directories = new Set<string>(["/"]);
  #files = new Map<string, VirtualEntry>();

  /** Add or replace a file. Repeating the same text is a no-op, so a draft
   * that did not change never invalidates the program. */
  write(path: string, text: string): void {
    const target = normalizePath(path);
    const existing = this.#files.get(target);
    if (existing?.text === text) {
      return;
    }
    this.#files.set(target, { text, version: (existing?.version ?? 0) + 1 });
    let parent = target.slice(0, target.lastIndexOf("/")) || "/";
    while (!this.#directories.has(parent)) {
      this.#directories.add(parent);
      parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
    }
  }

  /** Drop everything except the paths `keep` selects (the bundled lib files
   * survive a re-sync; repository files and drafts do not). */
  clear(keep?: (path: string) => boolean): void {
    for (const path of this.#files.keys()) {
      if (!keep?.(path)) {
        this.#files.delete(path);
      }
    }
    if (!keep) {
      this.#directories = new Set(["/"]);
      return;
    }
    const directories = new Set<string>(["/"]);
    for (const path of this.#files.keys()) {
      let parent = path.slice(0, path.lastIndexOf("/")) || "/";
      while (!directories.has(parent)) {
        directories.add(parent);
        parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
      }
    }
    this.#directories = directories;
  }

  has(path: string): boolean {
    return this.#files.has(normalizePath(path));
  }

  read(path: string): string | undefined {
    return this.#files.get(normalizePath(path))?.text;
  }

  versionOf(path: string): number {
    return this.#files.get(normalizePath(path))?.version ?? 0;
  }

  paths(): string[] {
    return [...this.#files.keys()];
  }

  /** `LanguageServiceHost` / `ModuleResolutionHost` surface, kept as bound
   * arrows so they can be handed straight to TypeScript. */
  readonly fileExists = (path: string): boolean => this.has(path);

  readonly readFile = (path: string): string | undefined => this.read(path);

  readonly directoryExists = (path: string): boolean =>
    this.#directories.has(normalizePath(path));

  readonly getDirectories = (path: string): string[] => {
    const root = normalizePath(path);
    const prefix = root === "/" ? "/" : `${root}/`;
    const names = new Set<string>();
    for (const directory of this.#directories) {
      if (directory === prefix || !directory.startsWith(prefix)) {
        continue;
      }
      const [name] = directory.slice(prefix.length).split("/");
      if (name) {
        names.add(name);
      }
    }
    return [...names].toSorted();
  };

  /** `ParseConfigHost.readDirectory`: every file under `rootDir` with one of
   * `extensions`, minus what the spec excludes, plus what it includes. */
  readonly readDirectory = (
    rootDir: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[],
    // Depth is irrelevant: the repository listing is already bounded.
    _depth?: number
  ): string[] => {
    const root = normalizePath(rootDir);
    const prefix = root === "/" ? "/" : `${root}/`;
    const paths: string[] = [];
    for (const path of this.#files.keys()) {
      if (!path.startsWith(prefix) && path !== root) {
        continue;
      }
      if (!extensions.some((extension) => path.endsWith(extension))) {
        continue;
      }
      if ((excludes ?? []).some((spec) => specMatches(path, spec))) {
        continue;
      }
      if (
        includes.length > 0 &&
        !includes.some((spec) => specMatches(path, spec))
      ) {
        continue;
      }
      paths.push(path);
    }
    return paths.toSorted();
  };
}
