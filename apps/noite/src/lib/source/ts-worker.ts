//! The source browser's TypeScript language service, in a web worker.
//!
//! Everything heavy lives here: the compiler (`typescript-ls`, the JS 5.x
//! implementation — the repo's own `typescript@7` pin is the native port and
//! exposes no `createLanguageService`), TypeScript's lib `.d.ts` files inlined
//! at build time, and one `LanguageService` over a virtual FS built from
//! `source.bundle` (the repo's text sources at the browsing ref, lockfiles
//! included) and the editor's live drafts.
//!
//! Package declarations are this worker's own business: for the file the pane
//! asks about, it reads the bare specifiers that file's program needs — its
//! own imports, those of the repository files it reaches, and the `types` a
//! tsconfig asks for — pins each package to the version the repo's lockfile
//! holds, and fetches the declarations from esm.sh in the background
//! (`esm-fetch.ts`) into `/__esm/…`, cached in the Cache API.
//! `resolveModuleNames` and `resolveTypeReferenceDirectives` fall back to what
//! that fetched, so an import is typed as soon as its declarations land and
//! stays unresolved otherwise — the only other network in the worker, and it
//! never blocks a reply.
//!
//! Paths are `/`-rooted (`/src/main.ts`, `/__esm/esm.sh/zod@3.23.8/index.d.ts`)
//! — `getCurrentDirectory()` is `/`. The server actions run on the main thread
//! and arrive in the `sync` message.

import ts from "typescript-ls";

import { collectSpecifiers, EsmTypes } from "./esm-fetch";
import {
  collectVersions,
  ESM_TYPES_DIR,
  jsxRuntimeSpecifiers,
  parsePackageSpecifier,
} from "./esm-types";
import type { JsxMode } from "./esm-types";
import {
  isScriptFile,
  lineStarts,
  positionAtOffset,
  severityFromCategory,
} from "./intel-protocol";
import type {
  IntelCompletion,
  IntelDefinition,
  IntelDiagnostic,
  IntelQuickInfo,
  IntelMessage,
  IntelRequest,
  IntelResult,
} from "./intel-protocol";
import { defaultCompilerOptions, resolveRepoConfig } from "./ts-config";
import { VirtualFs } from "./virtual-fs";

/** TypeScript's own lib `.d.ts`, inlined at build time (`?raw`). They ship in
 * the package, so a repo without any network access still gets `Array`,
 * `Promise`, the DOM — everything the language service needs to resolve
 * `getDefaultLibFileName` and the `lib` option. */
const libModules = import.meta.glob<string>(
  "/node_modules/typescript-ls/lib/lib.*.d.ts",
  { eager: true, exhaustive: true, import: "default", query: "?raw" }
);

/** Where the libs live in the virtual FS. A directory of their own, so a repo
 * file named `lib.d.ts` at its root cannot shadow them. */
const LIB_DIR = "/__libs";
const LIB_FALLBACK = `${LIB_DIR}/lib.esnext.full.d.ts`;

/** Diagnostics beyond this are dropped: the pane is for reading, and a broken
 * file can report thousands. */
const MAX_DIAGNOSTICS = 300;

/** Hover lines kept (JSDoc can be arbitrarily long). */
const MAX_HOVER_LINES = 40;

/** Declaration lines shown for a definition the pane cannot open. */
const PREVIEW_RADIUS = 4;

const fs = new VirtualFs();
const libPaths = new Set<string>();

for (const [specifier, text] of Object.entries(libModules)) {
  const name = specifier.slice(specifier.lastIndexOf("/") + 1);
  fs.write(`${LIB_DIR}/${name}`, text);
  libPaths.add(`${LIB_DIR}/${name}`);
}

if (libPaths.size === 0) {
  throw new Error("ts-worker: TypeScript's lib .d.ts were not bundled");
}

/** Repository paths from the last sync — the files the tree can open, and
 * therefore the only go-to-definition targets that navigate. The declarations
 * fetched from esm.sh are in the FS but not in the tree. */
let treeFiles = new Set<string>();

/** Program roots: the config's file list, plus every file the editor asks
 * about (a file outside the repo's `include` must still answer). */
const roots = new Set<string>();
let options: ts.CompilerOptions = defaultCompilerOptions();
let service: ts.LanguageService | undefined;

const snapshots = new Map<
  string,
  { snapshot: ts.IScriptSnapshot; version: number }
>();

/** Cached per version: the lib `.d.ts` are megabytes and the line map built by
 * `fromString` is the expensive part. */
const snapshotFor = (fileName: string): ts.IScriptSnapshot | undefined => {
  const text = fs.read(fileName);

  if (text === undefined) {
    return undefined;
  }

  const version = fs.versionOf(fileName);
  const cached = snapshots.get(fileName);

  if (cached?.version === version) {
    return cached.snapshot;
  }

  const snapshot = ts.ScriptSnapshot.fromString(text);
  snapshots.set(fileName, { snapshot, version });

  return snapshot;
};

const resolutionHost: ts.ModuleResolutionHost = {
  directoryExists: fs.directoryExists,
  fileExists: fs.fileExists,
  getDirectories: fs.getDirectories,
  readFile: fs.readFile,
};

/** The language service's default lib, resolved against the bundled libs (a
 * repo pinned to an ancient `target` asks for `lib.d.ts`, which the 5.x
 * package no longer ships separately — the ESNext full lib is the safe stand
 * in). */
const libFileNameFor = (compilation: ts.CompilerOptions): string => {
  const name = `${LIB_DIR}/${ts.getDefaultLibFileName(compilation)}`;

  return libPaths.has(name) ? name : LIB_FALLBACK;
};

/** TypeScript's extension for a fetched declaration: the file is named after
 * the URL it came from, so its suffix is the truth. */
const extensionOf = (path: string): ts.Extension => {
  if (path.endsWith(".d.mts")) {
    return ts.Extension.Dmts;
  }

  if (path.endsWith(".d.cts")) {
    return ts.Extension.Dcts;
  }

  if (path.endsWith(".d.ts")) {
    return ts.Extension.Dts;
  }

  if (path.endsWith(".mts")) {
    return ts.Extension.Mts;
  }

  if (path.endsWith(".cts")) {
    return ts.Extension.Cts;
  }

  if (path.endsWith(".tsx")) {
    return ts.Extension.Tsx;
  }

  if (path.endsWith(".ts")) {
    return ts.Extension.Ts;
  }

  return ts.Extension.Js;
};

/** The worker's global surface. `self` is typed as `window` by the DOM lib, so
 * the two members used here are declared explicitly. */
interface IntelScope {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<IntelRequest>) => void
  ) => void;
  postMessage: (message: IntelMessage) => void;
}

// SAFETY: a module worker's global is a DedicatedWorkerGlobalScope — it has
// `postMessage(message)` with no target origin and `message` events, which the
// DOM lib's `window` shape cannot express; this is the only cast in the file.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the DOM lib's window shape and a worker scope do not overlap enough for a single assertion
const scope = globalThis as unknown as IntelScope;

/** Tell the pane that declarations landed after it painted: whatever it showed
 * before them is worth checking again. */
const notifyTypesChanged = (): void => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin
  scope.postMessage({ kind: "typesChanged" });
};

/** Package declarations fetched from esm.sh (`esm-fetch.ts`), and the two
 * things the host has to do about them: put the files in the FS, and drop the
 * program when new ones land. A live program caches its resolutions, so a
 * declaration that arrives after it was built is invisible to it — dropping the
 * service is what makes the next check see it. The document registry (hoisted
 * below) keeps the parsed files, so rebuilding is not re-parsing. */
const esm = new EsmTypes({
  changed: () => {
    service = undefined;
    notifyTypesChanged();
  },
  debug: (message) => {
    // oxlint-disable-next-line no-console -- one line per acquisition, and only when something was left unresolved: see `#summarize` in esm-fetch.ts.
    console.debug(message);
  },
  warn: (message) => {
    // oxlint-disable-next-line no-console -- the acquisition caps, which is the one thing about package types a user can act on.
    console.warn(message);
  },
  write: (path, text) => {
    fs.write(path, text);
  },
});

/** Whether a type-reference entry is the plain-name form (the other form is a
 * parsed reference). */
const isDirectiveName = (entry: string | ts.FileReference): entry is string =>
  typeof entry === "string";

const host: ts.LanguageServiceHost = {
  directoryExists: fs.directoryExists,
  fileExists: fs.fileExists,
  getCompilationSettings: () => options,
  getCurrentDirectory: () => "/",
  getDefaultLibFileName: libFileNameFor,
  getDirectories: fs.getDirectories,
  getScriptFileNames: () => [...roots],
  getScriptSnapshot: snapshotFor,
  getScriptVersion: (fileName) => String(fs.versionOf(fileName)),
  readDirectory: fs.readDirectory,
  readFile: fs.readFile,
  // The repo's own resolution first — relative imports, `tsconfig` `paths`, and
  // the relative specifiers inside a fetched declaration (the FS mirrors the
  // URL paths, so they resolve here) — then what esm.sh served for a bare
  // specifier or an absolute declaration URL.
  resolveModuleNames: (moduleNames, containingFile) =>
    moduleNames.map((name) => {
      const resolved = ts.resolveModuleName(
        name,
        containingFile,
        options,
        resolutionHost
      ).resolvedModule;

      if (resolved) {
        return resolved;
      }

      const mapped = esm.resolve(name, containingFile);

      return mapped === undefined
        ? undefined
        : {
            extension: extensionOf(mapped),
            isExternalLibraryImport: true,
            resolvedFileName: mapped,
          };
    }),
  // `/// <reference types="…">` and a tsconfig's `types`: `@types` is not in
  // this FS, so the name is a package like any other import and resolves
  // against the same map (`@cloudflare/workers-types` is one such entry — it
  // ships no JavaScript, only the global declarations).
  resolveTypeReferenceDirectives: (names, containingFile) =>
    names.map((entry) => {
      const name = isDirectiveName(entry) ? entry : entry.fileName;

      const resolved = ts.resolveTypeReferenceDirective(
        name,
        containingFile,
        options,
        resolutionHost
      ).resolvedTypeReferenceDirective;

      if (resolved) {
        return resolved;
      }

      const mapped = esm.resolve(name, containingFile);

      return mapped === undefined
        ? undefined
        : {
            extension: extensionOf(mapped),
            primary: true,
            resolvedFileName: mapped,
          };
    }),
};

/** Parsed source files survive a rebuilt service: the registry is the one
 * thing that must outlive it. */
const registry = ts.createDocumentRegistry(true, "/");

const languageService = (): ts.LanguageService => {
  service ??= ts.createLanguageService(host, registry);

  return service;
};

/** How many repository files one program's closure is worth walking: an edit
 * is the open file and its neighbours, never the whole repo. */
const LOCAL_FILES_LIMIT = 200;

/** `programSpecifiers` memo, dropped whenever the repository's text moves
 * (a sync, or a draft the editor handed over): the closure is a property of
 * the sources, and the sources are what changed. */
const programs = new Map<string, string[]>();

/** How the config compiles JSX, in the terms the JSX-runtime rule speaks
 * (`esm-types.ts` never imports the compiler). */
const jsxModeOf = (jsx: ts.JsxEmit | undefined): JsxMode => {
  if (jsx === ts.JsxEmit.ReactJSXDev) {
    return "react-jsxdev";
  }

  if (jsx === ts.JsxEmit.ReactJSX) {
    return "react-jsx";
  }

  if (jsx === ts.JsxEmit.Preserve) {
    return "preserve";
  }

  return "classic";
};

/** The other thing the config decides that no import names: how JSX is
 * compiled, which is what says whether a `.tsx` file needs a runtime module. */
let jsxMode: JsxMode = "classic";

/** The bare specifiers the program rooted at `entry` needs: the imports of the
 * open file and of every repository file it reaches through relative imports —
 * a local module's package import types the open file through it — plus the
 * `/// <reference types>` directives among them and the JSX runtime the
 * compiler resolves for every JSX file (an implicit import: nothing writes it,
 * and without it every element reports TS2875/TS7026). Nothing else in the repo
 * is fetched for: a `vite.config.ts` nobody opened must not drag in Vite's and
 * wrangler's graphs. */
const programSpecifiers = (entry: string): string[] => {
  const cached = programs.get(entry);

  if (cached !== undefined) {
    return cached;
  }

  const specifiers = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0 && seen.size < LOCAL_FILES_LIMIT) {
    const file = queue.pop();

    if (file === undefined || seen.has(file)) {
      continue;
    }

    seen.add(file);
    const text = fs.read(file);

    if (text === undefined) {
      continue;
    }

    for (const specifier of jsxRuntimeSpecifiers({
      file,
      importSource: options.jsxImportSource,
      mode: jsxMode,
      text,
    })) {
      specifiers.add(specifier);
    }

    for (const specifier of collectSpecifiers(text)) {
      if (parsePackageSpecifier(specifier) !== null) {
        specifiers.add(specifier);
        continue;
      }

      if (!(specifier.startsWith(".") || specifier.startsWith("/"))) {
        // A scheme (`node:fs`) or an absolute URL: neither is a repository
        // file this walk can descend into, and nothing types either.
        continue;
      }

      const target = ts.resolveModuleName(
        specifier,
        file,
        options,
        resolutionHost
      ).resolvedModule?.resolvedFileName;

      if (
        target !== undefined &&
        isScriptFile(target) &&
        !target.startsWith(`${ESM_TYPES_DIR}/`)
      ) {
        queue.push(target);
      }
    }
  }

  const list = [...specifiers];
  programs.set(entry, list);

  return list;
};

/** The `types` the tsconfig asked for: global declarations no import names, so
 * they ride every acquisition (`@cloudflare/workers-types` ships no JavaScript,
 * only the globals a Worker file uses). */
let configTypes: readonly string[] = [];

/** Fetch what the open file's program names. Called from every request that
 * names a file — diagnostics, hover, definition, completion, a draft — because
 * that request is what says which file is on screen. Rounds are serialized, so
 * the file's own imports land before the tsconfig's global declarations: the
 * pane's diagnostics refresh as soon as the first of those lands rather than
 * when the whole graph has. */
const ensureTypes = (path: string): void => {
  void esm.acquire(programSpecifiers(`/${path}`));

  if (configTypes.length > 0) {
    void esm.acquire(configTypes);
  }
};

/** Rebuild everything for a fresh repository snapshot. */
const install = (request: Extract<IntelRequest, { kind: "sync" }>): void => {
  fs.clear(
    (path) => libPaths.has(path) || path.startsWith(`${ESM_TYPES_DIR}/`)
  );
  snapshots.clear();
  programs.clear();
  service = undefined;
  treeFiles = new Set(request.bundle.files.map((file) => `/${file.path}`));

  for (const file of request.bundle.files) {
    fs.write(`/${file.path}`, file.text);
  }

  for (const draft of request.drafts) {
    fs.write(`/${draft.path}`, draft.text);
  }

  const { options: compilation, roots: configRoots } = resolveRepoConfig(fs, [
    ...treeFiles,
  ]);

  options = compilation;
  configTypes = compilation.types ?? [];
  jsxMode = jsxModeOf(compilation.jsx);
  roots.clear();

  for (const root of configRoots) {
    roots.add(root);
  }

  for (const draft of request.drafts) {
    roots.add(`/${draft.path}`);
  }

  // The declarations are fetched, not received: the versions come from the
  // lockfile the bundle carries, and the fetch runs detached so the pane
  // answers from the repo's own sources meanwhile.
  esm.setVersions(collectVersions(request.bundle.files));
};

/** The pane's file, in the program: a file the repo's `include` misses is not
 * diagnosable until it is a root. */
const rooted = (path: string): string => {
  const target = `/${path}`;
  roots.add(target);

  return target;
};

const diagnosticsFor = (path: string): IntelDiagnostic[] => {
  const target = rooted(path);

  const found = [
    ...languageService().getSyntacticDiagnostics(target),
    ...languageService().getSemanticDiagnostics(target),
  ];

  const diagnostics: IntelDiagnostic[] = [];

  for (const diagnostic of found) {
    if (diagnostic.start === undefined) {
      continue;
    }

    diagnostics.push({
      code: diagnostic.code,
      end: diagnostic.start + (diagnostic.length ?? 0),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      severity: severityFromCategory(diagnostic.category),
      start: diagnostic.start,
    });

    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      break;
    }
  }

  return diagnostics;
};

const quickInfoAt = (path: string, offset: number): IntelQuickInfo | null => {
  const info = languageService().getQuickInfoAtPosition(rooted(path), offset);

  if (!info) {
    return null;
  }

  const signature = ts
    .displayPartsToString(info.displayParts)
    .split("\n")
    .slice(0, MAX_HOVER_LINES)
    .join("\n");

  const docs: string[] = [];
  const documentation = ts.displayPartsToString(info.documentation);

  if (documentation !== "") {
    docs.push(...documentation.split("\n"));
  }

  for (const tag of info.tags ?? []) {
    const text = ts.displayPartsToString(tag.text).trim();
    docs.push(text === "" ? `@${tag.name}` : `@${tag.name} ${text}`);
  }

  if (signature === "" && docs.length === 0) {
    return null;
  }

  return { docs: docs.slice(0, MAX_HOVER_LINES), signature };
};

/** The declaration lines around `line`, for a target the pane cannot open. */
const previewAround = (target: string, line: number): string[] | undefined => {
  const text = fs.read(target);

  if (text === undefined) {
    return undefined;
  }

  const lines = text.split("\n");
  const first = Math.max(0, line - PREVIEW_RADIUS);

  return lines.slice(first, Math.min(lines.length, line + PREVIEW_RADIUS + 1));
};

const definitionAt = (path: string, offset: number): IntelDefinition | null => {
  const first = languageService().getDefinitionAtPosition(
    rooted(path),
    offset
  )?.[0];

  if (!first) {
    return null;
  }

  const target = first.fileName;
  const text = fs.read(target);

  const start = positionAtOffset(
    text === undefined ? [0] : lineStarts(text),
    first.textSpan.start
  );

  // Files from the tree open in the pane; the declarations fetched from
  // esm.sh and the bundled libs have no tree entry, so they answer with the
  // declaration text around the target instead (the caller renders it
  // read-only).
  if (treeFiles.has(target)) {
    return { path: target.slice(1), start };
  }

  const preview = previewAround(target, start.line);

  return preview ? { path: target.slice(1), preview, start } : null;
};

/** The completion TypeScript ranks first — the entry inline prediction shows
 * as ghost text. */
const completionAt = (path: string, offset: number): IntelCompletion | null => {
  const info = languageService().getCompletionsAtPosition(
    rooted(path),
    offset,
    {}
  );

  const entry = info?.entries[0];

  if (!entry) {
    return null;
  }

  return {
    insertText: entry.insertText ?? entry.name,
    kind: String(entry.kind),
    name: entry.name,
  };
};

/** How long a draft's new imports settle before they are fetched: a keystroke
 * is not an acquisition, a pause is. */
const SCAN_DELAY_MS = 500;

/** The newest scan asked for per path: a later keystroke bumps it, and the
 * timer an earlier one left behind then finds itself superseded. (Cheaper and
 * more portable than holding a timer handle: the worker's `setTimeout` is not
 * the browser's, and a superseded callback is a no-op.) */
const scans = new Map<string, number>();
let scanGeneration = 0;

/** A draft's new imports are worth fetching — the user typed `import … from
 * "x"` and the type of `x` should follow — but not on every keystroke. */
const scheduleScan = (path: string): void => {
  scanGeneration += 1;
  const generation = scanGeneration;
  scans.set(path, generation);
  setTimeout(() => {
    if (scans.get(path) !== generation) {
      return;
    }

    scans.delete(path);
    ensureTypes(path);
  }, SCAN_DELAY_MS);
};

/** Answer one request; a throw becomes an error reply (the client resolves
 * failures to null and the pane carries on). */
const respond = (id: number, run: () => IntelResult): void => {
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin
    scope.postMessage({ id, ok: true, value: run() });
  } catch (error) {
    const message: IntelMessage = {
      error: error instanceof Error ? error.message : String(error),
      id,
      ok: false,
    };

    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin
    scope.postMessage(message);
  }
};

scope.addEventListener("message", (event) => {
  const request = event.data;

  switch (request.kind) {
    case "sync": {
      respond(request.id, () => {
        install(request);

        return null;
      });
      break;
    }

    case "update": {
      fs.write(`/${request.path}`, request.text);
      // The draft moved the sources, so the closure the memo holds for that
      // file — its own imports included — is stale.
      programs.delete(`/${request.path}`);
      scheduleScan(request.path);
      break;
    }

    case "diagnostics": {
      ensureTypes(request.path);
      respond(request.id, () => diagnosticsFor(request.path));
      break;
    }

    case "quickInfo": {
      ensureTypes(request.path);
      respond(request.id, () => quickInfoAt(request.path, request.offset));
      break;
    }

    case "definition": {
      ensureTypes(request.path);
      respond(request.id, () => definitionAt(request.path, request.offset));
      break;
    }

    default: {
      ensureTypes(request.path);
      respond(request.id, () => completionAt(request.path, request.offset));
    }
  }
});
