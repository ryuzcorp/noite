//! The source browser's TypeScript language service, in a web worker.
//!
//! Everything heavy lives here: the compiler (`typescript-ls`, the JS 5.x
//! implementation — the repo's own `typescript@7` pin is the native port and
//! exposes no `createLanguageService`), TypeScript's lib `.d.ts` files inlined
//! at build time, and one `LanguageService` over a virtual FS built from
//! `source.bundle` (the repo's text sources at the browsing ref),
//! `source.types` (declarations captured from the app's last successful build)
//! and the editor's live drafts.
//!
//! Paths are `/`-rooted (`/src/main.ts`, `/node_modules/react/index.d.ts`) —
//! `getCurrentDirectory()` is `/`. Nothing here touches the network: the two
//! server actions run on the main thread and arrive in the `sync` message.

import ts from "typescript-ls";

import {
  lineStarts,
  positionAtOffset,
  severityFromCategory,
} from "./intel-protocol";
import type {
  IntelCompletion,
  IntelDefinition,
  IntelDiagnostic,
  IntelQuickInfo,
  IntelReply,
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
 * therefore the only go-to-definition targets that navigate. Declarations from
 * the build (`source.types`) are in the FS but not in the tree. */
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
  // `/// <reference types="…">` needs no override: without one the service
  // resolves those itself through this host's file system (which is why the
  // fs members above have to be real, not stubs).
  resolveModuleNames: (moduleNames, containingFile) =>
    moduleNames.map(
      (name) =>
        ts.resolveModuleName(name, containingFile, options, resolutionHost)
          .resolvedModule
    ),
};

const languageService = (): ts.LanguageService => {
  service ??= ts.createLanguageService(
    host,
    ts.createDocumentRegistry(true, "/")
  );
  return service;
};

/** Rebuild everything for a fresh repository snapshot. */
const install = (request: Extract<IntelRequest, { kind: "sync" }>): void => {
  fs.clear((path) => libPaths.has(path));
  snapshots.clear();
  service = undefined;
  treeFiles = new Set(request.bundle.files.map((file) => `/${file.path}`));
  for (const file of request.bundle.files) {
    fs.write(`/${file.path}`, file.text);
  }
  // Captured declarations arrive rooted at `node_modules/`, where TS resolves
  // bare imports and `types` directives.
  for (const file of request.types.files) {
    fs.write(`/${file.path}`, file.text);
  }
  for (const draft of request.drafts) {
    fs.write(`/${draft.path}`, draft.text);
  }
  const { options: compilation, roots: configRoots } = resolveRepoConfig(fs, [
    ...treeFiles,
  ]);
  options = compilation;
  roots.clear();
  for (const root of configRoots) {
    roots.add(root);
  }
  for (const draft of request.drafts) {
    roots.add(`/${draft.path}`);
  }
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
  // Files from the tree open in the pane; `node_modules` declarations and the
  // bundled libs have no tree entry, so they answer with the declaration text
  // around the target instead (the caller renders it read-only).
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

/** The worker's global surface. `self` is typed as `window` by the DOM lib, so
 * the two members used here are declared explicitly. */
interface IntelScope {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<IntelRequest>) => void
  ) => void;
  postMessage: (message: IntelReply) => void;
}

// SAFETY: a module worker's global is a DedicatedWorkerGlobalScope — it has
// `postMessage(message)` with no target origin and `message` events, which the
// DOM lib's `window` shape cannot express; this is the only cast in the file.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the DOM lib's window shape and a worker scope do not overlap enough for a single assertion
const scope = globalThis as unknown as IntelScope;

/** Answer one request; a throw becomes an error reply (the client resolves
 * failures to null and the pane carries on). */
const respond = (id: number, run: () => IntelResult): void => {
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin
    scope.postMessage({ id, ok: true, value: run() });
  } catch (error) {
    const message: IntelReply = {
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
      break;
    }
    case "diagnostics": {
      respond(request.id, () => diagnosticsFor(request.path));
      break;
    }
    case "quickInfo": {
      respond(request.id, () => quickInfoAt(request.path, request.offset));
      break;
    }
    case "definition": {
      respond(request.id, () => definitionAt(request.path, request.offset));
      break;
    }
    default: {
      respond(request.id, () => completionAt(request.path, request.offset));
    }
  }
});
