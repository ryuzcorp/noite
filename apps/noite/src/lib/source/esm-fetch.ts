//! Package type acquisition from esm.sh — the worker's half.
//!
//! The language-service worker has no `node_modules` to read: a repo's bare
//! imports resolve against declarations fetched from esm.sh, at the versions
//! the repo's own lockfile pins (`esm-types.ts` is the pure half of that: which
//! URL a specifier names, which candidates a declaration's own imports point
//! at, which versions the lockfile holds).
//!
//! This is the fetching half, and it lives in the worker because that is where
//! the network is free: the main thread never sees an esm.sh URL, and the
//! editor never waits on one. A round is bounded (concurrency, files, bytes),
//! scoped (the caller asks for the open file's program, not the repository's
//! every specifier) and cached in the Cache API — the versioned esm.sh URLs
//! are immutable, so both what they served and what they refused are worth
//! keeping. It is forgiving: a package that cannot be fetched — offline,
//! blocked, 404, private — is simply a specifier that stays unresolved, which
//! TypeScript reports exactly as it did before. Nothing here may throw into
//! the editor.

import ts from "typescript-ls";

import {
  canonicalUrl,
  declarationTargets,
  entryTypeCandidates,
  esmModuleUrl,
  ESM_TYPES_DIR,
  FETCH_CONCURRENCY,
  isCodeSubpath,
  MAX_TYPES_BYTES,
  MAX_TYPES_FILE,
  MAX_TYPES_FILES,
  MISS_CACHE_NAME,
  MISS_EXPIRY_HEADER,
  missExpiry,
  parsePackageSpecifier,
  typesUrlOfPath,
  typesVirtualPath,
} from "./esm-types";
import type { PackageVersions } from "./esm-types";

/** Cache storage names; bump them to drop everything an older version of this
 * module cached. */
const CACHE_NAME = "noite-esm-types";

/** One fetch of an esm.sh URL, with every failure — offline, blocked, DNS —
 * folded into "no response", because that is all the caller can act on. */
const fetchResponse = async (url: string): Promise<Response | undefined> => {
  let response: Response | undefined;

  try {
    response = await fetch(url, {
      credentials: "omit",
      mode: "cors",
      redirect: "follow",
    });
  } catch {
    // Offline, blocked, DNS: the caller sees no response and moves on.
  }

  return response;
};

/** An absolute URL — what a transformed declaration's imports are. */
const HTTP_URL = /^https?:\/\//u;

/** What one URL's fetch yielded. `status` 0 is "nothing answered at all"
 * (offline, blocked, DNS) — a fact about this attempt, not about the URL, so
 * it is never remembered as a miss. */
interface FetchedText {
  status: number;
  text?: string;
}

/** What the acquisition needs from its host (the worker's virtual FS, and a
 * way to say something landed). */
export interface EsmTypesHost {
  /** Declarations landed that were not there before: the program has new files
   * and the pane's diagnostics are worth re-running. */
  changed: () => void;
  /** One line per acquisition, at most, naming what could not be resolved —
   * packages that ship no declarations are the norm, not an error. */
  debug: (message: string) => void;
  /** One line, once: the acquisition caps stopped the graph from landing. */
  warn: (message: string) => void;
  /** Put a fetched declaration into the virtual FS. */
  write: (path: string, text: string) => void;
}

/** `/// <reference types="x" />` / `/// <reference path="x" />`: TypeScript's
 * pre-scan reports imports and dynamic imports only, so the directives are read
 * off the text (a `lib` reference is skipped — the bundled libs answer those). */
const REFERENCE_DIRECTIVE =
  /\/\/\/\s*<reference\s+(?:path|types)\s*=\s*["'](?<specifier>[^"']+)["']/gu;

/** The specifiers one source text mentions: static and dynamic imports,
 * `import type`, `require` (TypeScript's own pre-scan, which is what gets
 * comments, strings and `import(…)` right) plus the reference directives. */
export const collectSpecifiers = (text: string): string[] => {
  const specifiers = ts
    .preProcessFile(text, true, true)
    .importedFiles.map((file) => file.fileName);

  for (const match of text.matchAll(REFERENCE_DIRECTIVE)) {
    const specifier = match.groups?.specifier;

    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
};

export class EsmTypes {
  /** Bare specifier (as written) → the virtual path of its entry declaration. */
  readonly #bare = new Map<string, string>();
  /** Declaration URL → its virtual path. The map is also the cycle breaker:
   * a declaration is registered before its own imports are queued. */
  readonly #urls = new Map<string, string>();
  /** Module URL → the declaration URL its `X-TypeScript-Types` header named. */
  readonly #modules = new Map<string, string>();
  /** In-flight loads, so two declarations naming one import fetch it once. */
  readonly #declarations = new Map<string, Promise<string | undefined>>();
  readonly #moduleLookups = new Map<string, Promise<string | undefined>>();
  /** URLs that answered nothing usable. Immutable, so this never clears. */
  readonly #failed = new Set<string>();
  /** Specifiers already fetched, or known to have no types. */
  readonly #requested = new Set<string>();
  /** Specifiers that cannot be resolved at all (no version, no declarations). */
  readonly #unresolved = new Set<string>();
  /** The version each bare specifier was judged at, `""` when no lockfile can
   * move it (it names no package, or one this repo does not depend on): the
   * one thing a new ref's lockfile invalidates (`setVersions`). Declaration
   * URLs are never in here — they carry their version themselves. */
  readonly #judged = new Map<string, string>();
  /** Specifiers that ended a round with no declarations, in order: what the
   * round's one summary line names. */
  readonly #misses: string[] = [];
  readonly #caches = new Map<string, Promise<Cache | undefined>>();
  readonly #host: EsmTypesHost;
  #versions: PackageVersions = new Map();
  #capped = false;
  #files = 0;
  #bytes = 0;
  #stored = 0;
  /** How many times a specifier's resolution has moved — gained one, or lost
   * one to a lockfile that stopped pinning it. A round compares this to know
   * the pane's diagnostics are worth re-running, which is not the same as "a
   * file landed": a resolution can be published out of what the FS already
   * holds, and dropping one changes what resolves just as much. */
  #resolutions = 0;
  #queue: (() => Promise<void>)[] = [];
  #active = 0;
  #outstanding = 0;
  #drained: (() => void) | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(host: EsmTypesHost) {
    this.#host = host;
  }

  /** The versions the next acquisition resolves against. They move with the
   * ref — the lockfile belongs to the repo — while the declarations already
   * fetched do not: their URLs carry the version and never change, so what a
   * specifier resolved to stands for as long as its package's version does.
   * Only the specifiers the new lockfile moved are judged again — and only
   * they are re-fetched.
   *
   * Everything the pane asks right after a switch is answered against these
   * maps, before the re-acquisition has run: a specifier the two lockfiles
   * agree on has to resolve there, or the open file reads as importing a
   * module the worker is holding (TS2307) until something else re-checks it. */
  setVersions(versions: PackageVersions): void {
    this.#versions = versions;

    // `#versionOf` reads the lockfile that just arrived: a specifier whose
    // version it no longer pins (or pins differently) is judged again.
    for (const [specifier, judged] of this.#judged) {
      if (this.#versionOf(specifier) !== judged) {
        this.#forget(specifier);
      }
    }
  }

  /** Fetch what `specifiers` name (and, transitively, what their declarations
   * import), then report whether anything new landed. Rounds are serialized:
   * one acquisition at a time keeps the caps meaningful and the reports
   * ordered. */
  async acquire(specifiers: Iterable<string>): Promise<void> {
    const previous = this.#tail;

    const next = (async (): Promise<void> => {
      await previous;
      await this.#run(specifiers);
    })();

    this.#tail = next;
    await next;
  }

  /** The virtual path `specifier`, read in `containingFile`, resolves to —
   * undefined when nothing was fetched for it, which leaves the import
   * unresolved exactly as it was before esm.sh entered the picture. */
  resolve(
    specifier: string,
    containingFile: string | undefined
  ): string | undefined {
    if (HTTP_URL.test(specifier)) {
      return this.#urls.get(canonicalUrl(specifier));
    }

    const bare = this.#bare.get(specifier);

    if (bare !== undefined) {
      return bare;
    }

    // A relative specifier inside a fetched declaration: TypeScript's own
    // resolver finds these in the virtual FS, but it has no reason to know
    // that `./x.mjs` is served as `x.d.mts` — this is where that is decided.
    if (
      containingFile !== undefined &&
      containingFile.startsWith(`${ESM_TYPES_DIR}/`) &&
      (specifier.startsWith(".") || specifier.startsWith("/"))
    ) {
      for (const target of declarationTargets(
        specifier,
        typesUrlOfPath(containingFile)
      )) {
        const hit = this.#urls.get(target);

        if (hit !== undefined) {
          return hit;
        }
      }
    }

    return undefined;
  }

  async #run(specifiers: Iterable<string>): Promise<void> {
    const before = this.#stored;
    const resolved = this.#resolutions;
    const missed = this.#misses.length;
    const round = Promise.withResolvers<undefined>();
    this.#drained = () => {
      round.resolve();
    };

    for (const specifier of specifiers) {
      if (this.#atCapacity()) {
        break;
      }

      if (
        this.#bare.has(specifier) ||
        this.#requested.has(specifier) ||
        this.#unresolved.has(specifier)
      ) {
        continue;
      }

      this.#requested.add(specifier);
      this.#enqueue(() => this.#bareFor(specifier));
    }

    if (this.#outstanding === 0) {
      this.#drained?.();
      this.#drained = undefined;
    }

    await round.promise;

    // A round moves what the pane's imports mean either by landing files or by
    // resolving a specifier out of what is already in the FS (a ref whose
    // lockfile pins a package the previous ref only reached through another
    // declaration): either way the check the pane painted before this round is
    // worth running again.
    if (this.#stored !== before || this.#resolutions !== resolved) {
      this.#host.changed();
    }

    this.#summarize(missed);
  }

  /** One line for the specifiers this round could not resolve. A package that
   * ships no declarations is ordinary — every mono-repo has a handful — and
   * the pane already shows the unresolved import, so this is a debug detail,
   * never a per-package warning. */
  #summarize(from: number): void {
    const missed = this.#misses.slice(from);

    if (missed.length === 0) {
      return;
    }

    const names = missed.slice(0, 5).join(", ");
    const rest = missed.length > 5 ? `, +${missed.length - 5} more` : "";
    this.#host.debug(
      `[esm.sh] ${missed.length} import${missed.length === 1 ? "" : "s"} without declarations: ${names}${rest}`
    );
  }

  /** The version the lockfile pins `specifier`'s package to, `""` when nothing
   * can be pinned — it names no package (a `tsconfig` `paths` alias, a
   * builtin, a URL), or one this repo does not depend on. */
  #versionOf(specifier: string): string {
    const parsed = parsePackageSpecifier(specifier);

    return parsed === null ? "" : (this.#versions.get(parsed.name) ?? "");
  }

  /** Drop what was judged about `specifier`, so the next round asks the
   * lockfile the ref has now: what a version that moved (or left) invalidates,
   * and what an answer for a version nothing pins any more is worth. The
   * declaration URL it resolved to stays in the URL-keyed maps — it never
   * changes — only this specifier's reading of it does. */
  #forget(specifier: string): void {
    this.#judged.delete(specifier);

    if (this.#bare.delete(specifier)) {
      this.#resolutions += 1;
    }

    this.#requested.delete(specifier);
    this.#unresolved.delete(specifier);
  }

  /** Publish a round's answer for `specifier`, unless the lockfile moved the
   * version it answers for while the round was in flight (a branch switch
   * lands mid-fetch): then the specifier is forgotten instead, and the next
   * round resolves it against the lockfile the ref has now. An answer for a
   * version nothing pins would otherwise outlive every future lockfile. */
  #publish(specifier: string, version: string, answer: () => void): void {
    if (this.#versionOf(specifier) === version) {
      answer();

      return;
    }

    this.#forget(specifier);
  }

  /** Resolve one bare specifier to a declaration: esm.sh's own answer first
   * (its `X-TypeScript-Types` header, the route Deno uses), the package's
   * published declaration files second (for a types-only package, or one whose
   * build esbuild refuses). */
  async #bareFor(specifier: string): Promise<void> {
    const parsed = parsePackageSpecifier(specifier);

    if (parsed === null || !isCodeSubpath(parsed.subpath)) {
      // Not a package — a `tsconfig` `paths` alias, a builtin, a virtual
      // module — or a subpath naming something that is not code at all
      // (`pkg/package.json`, `pkg/logo.svg`): esm.sh has no declaration to
      // serve, and TypeScript resolves the former the way it always did.
      this.#unresolved.add(specifier);

      return;
    }

    const version = this.#versions.get(parsed.name);
    // The version this specifier is judged at, kept so the next ref's lockfile
    // re-judges exactly the specifiers it moved (`setVersions`). `""` records
    // a package no lockfile pins: settled where it is, until a lockfile that
    // pins one re-judges it.
    this.#judged.set(specifier, version ?? "");

    if (version === undefined) {
      this.#unresolved.add(specifier);

      return;
    }

    const moduleUrl = canonicalUrl(esmModuleUrl(parsed, version));
    const header = await this.#moduleTypes(moduleUrl);
    let path: string | undefined;

    if (header !== undefined) {
      path = await this.#declaration(header);
    }

    if (path === undefined) {
      /* The conventional declaration paths are alternatives, and esm.sh's
       * answers are unevenly slow — a 500 for a types-only package takes
       * seconds — so they are probed together: the first that exists is the
       * answer, and what does not exist is remembered, so an open pays for
       * this once. */
      const found = await Promise.all(
        entryTypeCandidates(moduleUrl).map((candidate) =>
          this.#declaration(candidate)
        )
      );

      path = found.find((candidate) => candidate !== undefined);
    }

    if (path !== undefined) {
      this.#publish(specifier, version, () => {
        this.#bare.set(specifier, path);
        this.#resolutions += 1;
      });

      return;
    }

    this.#publish(specifier, version, () => {
      this.#unresolved.add(specifier);
      this.#misses.push(`${specifier}@${version}`);
    });
  }

  /** The declaration URL a module URL's `X-TypeScript-Types` header names, or
   * undefined when there is none to read — a plain JavaScript package, or one
   * whose response esm.sh served from its CDN without exposing the header
   * (`Access-Control-Expose-Headers` is not always there, and a worker's CORS
   * fetch can only read what is exposed), which is why the entry candidates
   * are probed either way. The answer is memoized, and an in-flight lookup is
   * shared, so a specifier and a declaration naming the same module pay for it
   * once. */
  async #moduleTypes(moduleUrl: string): Promise<string | undefined> {
    const known = this.#modules.get(moduleUrl);

    if (known !== undefined) {
      return known;
    }

    if (this.#failed.has(moduleUrl)) {
      return;
    }

    const pending = this.#moduleLookups.get(moduleUrl);

    if (pending !== undefined) {
      return await pending;
    }

    const lookup = this.#lookupModuleTypes(moduleUrl);
    this.#moduleLookups.set(moduleUrl, lookup);

    return await lookup;
  }

  async #lookupModuleTypes(moduleUrl: string): Promise<string | undefined> {
    try {
      if (await this.#missed(moduleUrl)) {
        this.#failed.add(moduleUrl);

        return;
      }

      const response = await fetchResponse(moduleUrl);

      if (response === undefined) {
        // Nothing answered: not a fact about the module, so nothing is
        // remembered and a later round tries again.
        return;
      }

      if (!response.ok) {
        void response.body?.cancel();
        this.#failed.add(moduleUrl);
        await this.#rememberMiss(moduleUrl, response.status);

        return;
      }

      const header = response.headers.get("x-typescript-types");
      // The header is all this response is wanted for: drop the body (it is a
      // bundled module, megabytes for a big package).
      void response.body?.cancel();

      if (header === null) {
        return;
      }

      const url = canonicalUrl(
        new URL(header, response.url === "" ? moduleUrl : response.url).href
      );

      this.#modules.set(moduleUrl, url);

      return url;
    } finally {
      this.#moduleLookups.delete(moduleUrl);
    }
  }

  /** One declaration file: esm.sh's transformed copy, or the package's own
   * file through `?raw` when the transformation is what failed. */
  async #declaration(url: string): Promise<string | undefined> {
    const key = canonicalUrl(url);
    const known = this.#urls.get(key);

    if (known !== undefined) {
      return known;
    }

    if (this.#failed.has(key)) {
      return;
    }

    const pending = this.#declarations.get(key);

    if (pending !== undefined) {
      return await pending;
    }

    const loading = this.#loadDeclaration(key);
    this.#declarations.set(key, loading);

    return await loading;
  }

  async #loadDeclaration(key: string): Promise<string | undefined> {
    try {
      if (await this.#missed(key)) {
        this.#failed.add(key);

        return;
      }

      let fetched = await this.#fetchText(key);

      if (fetched.text === undefined && fetched.status >= 500) {
        // esm.sh found the file but could not build it (a types-only package,
        // whatever esbuild refuses): `?raw` serves the package's own file, the
        // same declaration. A 404 needs no second look — `?raw` serves that
        // same nonexistent file.
        const raw = await this.#fetchText(`${key}?raw`);

        if (raw.text !== undefined) {
          // Worth caching under the declaration's own URL: the next open then
          // reads the file straight out of the cache instead of paying for the
          // transformation esm.sh cannot do.
          await this.#rememberText(key, raw.text);
          fetched = raw;
        }
      }

      const { status, text } = fetched;

      if (text === undefined) {
        this.#failed.add(key);

        if (status !== 0) {
          await this.#rememberMiss(key, status);
        }

        return;
      }

      return this.#store(key, text);
    } finally {
      this.#declarations.delete(key);
    }
  }

  /** Cache one URL's text without a fetch — the `?raw` fallback's answer, under
   * the URL it stands for. */
  async #rememberText(key: string, text: string): Promise<void> {
    const cache = await this.#openCache(CACHE_NAME);

    if (cache === undefined) {
      return;
    }

    try {
      await cache.put(key, new Response(text));
    } catch {
      // Storing is an optimization; the text is already in hand.
    }
  }

  /** A URL a previous round could not fetch. The miss lives in the Cache API
   * with a TTL of its own, so the next open — a reload, another file, another
   * branch — does not pay for the same answer twice. */
  async #missed(url: string): Promise<boolean> {
    const cache = await this.#openCache(MISS_CACHE_NAME);

    if (cache === undefined) {
      return false;
    }

    let hit: Response | undefined;

    try {
      hit = await cache.match(url);
    } catch {
      return false;
    }

    if (!hit) {
      return false;
    }

    const expiry = Number(hit.headers.get(MISS_EXPIRY_HEADER) ?? 0);

    if (Date.now() < expiry) {
      return true;
    }

    try {
      await cache.delete(url);
    } catch {
      // A cache that cannot delete still must not break the round.
    }

    return false;
  }

  async #rememberMiss(url: string, status: number): Promise<void> {
    const cache = await this.#openCache(MISS_CACHE_NAME);

    if (cache === undefined) {
      return;
    }

    const entry = new Response(null, {
      headers: { [MISS_EXPIRY_HEADER]: String(missExpiry(status, Date.now())) },
    });

    try {
      await cache.put(url, entry);
    } catch {
      // Storing is an optimization; the fetch answered either way.
    }
  }

  /** Write a fetched declaration into the virtual FS and queue the specifiers
   * it names. The path is registered before the queue is touched, so a
   * declaration graph with a cycle terminates. */
  #store(url: string, text: string): string | undefined {
    const known = this.#urls.get(url);

    if (known !== undefined) {
      return known;
    }

    if (text.length > MAX_TYPES_FILE || this.#atCapacity()) {
      this.#capsReached();

      return undefined;
    }

    const path = typesVirtualPath(url);
    this.#urls.set(url, path);
    this.#files += 1;
    this.#bytes += text.length;
    this.#stored += 1;
    this.#host.write(path, text);

    for (const specifier of collectSpecifiers(text)) {
      const bare = parsePackageSpecifier(specifier);

      if (bare !== null) {
        if (
          !this.#bare.has(specifier) &&
          !this.#requested.has(specifier) &&
          !this.#unresolved.has(specifier)
        ) {
          this.#requested.add(specifier);
          this.#enqueue(() => this.#bareFor(specifier));
        }

        continue;
      }

      if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        HTTP_URL.test(specifier)
      ) {
        this.#enqueueTargets(declarationTargets(specifier, url));
      }
    }

    return path;
  }

  /** Try a specifier's candidate URLs in order, in one task: only the first
   * that exists is worth keeping (the rest are the same import). */
  #enqueueTargets(targets: readonly string[]): void {
    const keys = targets.filter(
      (target) =>
        !this.#urls.has(target) &&
        !this.#failed.has(target) &&
        !this.#requested.has(target)
    );

    if (keys.length === 0) {
      return;
    }

    for (const key of keys) {
      this.#requested.add(key);
    }

    this.#enqueue(async () => {
      /* oxlint-disable eslint/no-await-in-loop -- alternatives again: the first candidate that exists is the declaration, and the rest are the same import. */
      for (const key of keys) {
        if ((await this.#declaration(key)) !== undefined) {
          return;
        }
      }
      /* oxlint-enable eslint/no-await-in-loop */
    });
  }

  /** The text of one URL, from the cache when it is there. esm.sh's versioned
   * URLs are immutable, so a cached copy is never stale. */
  async #fetchText(url: string): Promise<FetchedText> {
    const cache = await this.#openCache(CACHE_NAME);

    if (cache !== undefined) {
      let hit: Response | undefined;

      try {
        hit = await cache.match(url);
      } catch {
        // An unreadable cache is a cache that does not answer.
      }

      if (hit?.ok) {
        return { status: hit.status, text: await hit.text() };
      }
    }

    const response = await fetchResponse(url);

    if (response === undefined) {
      return { status: 0 };
    }

    if (!response.ok) {
      void response.body?.cancel();

      return { status: response.status };
    }

    if (cache !== undefined) {
      // Storing is an optimization: a full or opaque cache must not lose the
      // text we already hold.
      try {
        await cache.put(url, response.clone());
      } catch {
        // Nothing to recover: the fetch is the source of truth.
      }
    }

    return { status: response.status, text: await response.text() };
  }

  /** One Cache API store, opened once. Absent (an insecure context, a browser
   * that refuses the storage) the acquisition still works, only slower. */
  #openCache(name: string): Promise<Cache | undefined> {
    let opened = this.#caches.get(name);

    if (opened === undefined) {
      opened = (async (): Promise<Cache | undefined> => {
        let cache: Cache | undefined;

        try {
          if (typeof caches !== "undefined") {
            cache = await caches.open(name);
          }
        } catch {
          // A browser that refuses the storage just means no cache.
        }

        return cache;
      })();
      this.#caches.set(name, opened);
    }

    return opened;
  }

  #atCapacity(): boolean {
    return this.#files >= MAX_TYPES_FILES || this.#bytes >= MAX_TYPES_BYTES;
  }

  #enqueue(task: () => Promise<void>): void {
    this.#outstanding += 1;
    this.#queue.push(task);
    this.#pump();
  }

  #pump(): void {
    while (this.#active < FETCH_CONCURRENCY && this.#queue.length > 0) {
      const task = this.#queue.shift();

      if (task === undefined) {
        break;
      }

      this.#active += 1;
      void this.#settle(task);
    }
  }

  /** Run one queued task to completion, whatever it does: a task that threw is
   * a package without types, never a failure of the round. */
  async #settle(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch {
      // Nothing to recover: the round's other tasks still run.
    }

    this.#active -= 1;
    this.#outstanding -= 1;

    if (this.#outstanding === 0) {
      this.#drained?.();
      this.#drained = undefined;
    }

    this.#pump();
  }

  /** The caps stopped the graph from landing: worth one line, because it is
   * the one failure the user can act on (a repository too big to type in the
   * browser), and it never fires for an ordinary one. */
  #capsReached(): void {
    if (this.#capped) {
      return;
    }

    this.#capped = true;
    this.#host.warn(
      "[esm.sh] declaration files hit the acquisition caps — some imports stay unresolved"
    );
  }
}
