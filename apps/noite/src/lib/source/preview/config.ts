//! Reading a checkout's backend config: which module is the Worker, which
//! directory holds the assets, what each binding is called. Everything here
//! is a **static read** of the file's text — nothing is executed and nothing
//! is imported — so a config that calls the clock or the network still plans.
//!
//! The shapes handled are the ones `@cloudflare/config`'s builders
//! (`defineWorker`/`bindings.*`) and Wrangler's own JSON produce. Each file is
//! parsed **once** at the boundary it enters through, by a guard that proves
//! exactly the fields this module reads; everything after that consumes the
//! read value, and anything a guard refuses reads as "the config did not
//! say".

import {
  callArguments,
  findImports,
  isLiteralValue,
  literalOf,
  parseJsonFile,
  scanCalls,
} from "./literal";
import type { LiteralObject, LiteralValue } from "./literal";

/** The config files the plan reads, as checkout-relative paths. */
export const CONFIG_FILES = [
  "package.json",
  "cloudflare.config.ts",
  "wrangler.json",
  "wrangler.jsonc",
] as const;

/** Every name a Vite config can carry. */
const VITE_CONFIG = /^vite\.config\.(?:[cm]?[jt]s)$/u;

/** Dependencies that only run through a native binary (`workerd`), or that
 * exist to drive it. A `dev` script that needs one of these cannot run in the
 * browser, so it never selects the `dev` mode. */
const NATIVE_ONLY_DEPS = [
  "@cloudflare/vite-plugin",
  "miniflare",
  "wrangler",
  "workerd",
] as const;

/** The static output directories a build leaves behind, in the order the
 * deploy-side generator tries them. */
const STATIC_DIRS = ["build", "dist", "out"] as const;

/** The fallback a missing asset answers with, as Cloudflare's own
 * `not_found_handling` spells it. */
export type NotFoundHandling = "404-page" | "none" | "single-page-application";

/** What kind of thing a binding is, as far as the preview is concerned. */
export type PreviewBindingKind =
  | "assets"
  | "d1"
  | "durable-object"
  | "json"
  | "kv"
  | "r2"
  | "secret"
  | "text";

/** One `env` entry the preview can build. */
export interface PreviewBinding {
  /** The `env` property the Worker reads. */
  kind: PreviewBindingKind;
  name: string;
  /** The backing store the config names (a D1 database, an R2 bucket, a KV
   * namespace), where it names one. */
  resource?: string;
  /** A Wrangler D1 entry's `migrations_dir`, when it names one. */
  migrationsDir?: string;
  /** A `text`/`json` binding's literal value, read out of the config. */
  value?: LiteralValue;
}

/** Everything the runtime needs to serve a checkout, read out of its config
 * files. Paths are checkout-relative; `null` means "the config did not say". */
export interface PreviewConfig {
  /** The assets directory: what `wrangler`'s `assets.directory` names, or the
   * first build-output directory (`build`, `dist`, `out`) holding an
   * `index.html`. */
  assets: string | null;
  bindings: PreviewBinding[];
  /** Runtime and dev dependencies as the manifest declares them, by name. */
  dependencies: Record<string, string>;
  /** The `dev` script, when the manifest has one. */
  dev: string | null;
  devDependencies: Record<string, string>;
  /** The Worker module — `wrangler`'s `main`, the `cf` config's `entrypoint`,
   * `package.json`'s `main`, or `src/index.ts`. */
  entry: string | null;
  /** An `index.html` at the checkout root: the client entry of a Vite app. */
  hasIndexHtml: boolean;
  /** A Vite config of any flavour sits at the checkout root. */
  hasViteConfig: boolean;
  notFoundHandling: NotFoundHandling;
  /** What the config could not say, one line each: the plan turns them into
   * notes, so a skipped binding is never a silent `undefined` in `env`. */
  unreadable: string[];
}

/** A `package.json`, as far as the preview reads it. */
interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  scripts?: { dev?: string };
}

/** The `assets` object of a Wrangler config. */
interface WranglerAssets {
  binding?: string;
  directory?: string;
  not_found_handling?: string;
}

/** One entry of a Wrangler binding list (`d1_databases`, `r2_buckets`, …):
 * the string fields the preview reads, all optional because the lists differ
 * in which of them they carry. */
interface WranglerNamedEntry {
  binding?: string;
  bucket_name?: string;
  class_name?: string;
  database_name?: string;
  id?: string;
  migrations_dir?: string;
  name?: string;
}

/** A `wrangler.json(c)`, as far as the preview reads it. */
interface WranglerConfig {
  assets?: WranglerAssets | string;
  d1_databases?: WranglerNamedEntry[];
  durable_objects?: { bindings?: WranglerNamedEntry[] };
  kv_namespaces?: WranglerNamedEntry[];
  main?: string;
  r2_buckets?: WranglerNamedEntry[];
  vars?: LiteralObject;
}

/** What a `cloudflare.config.ts` declares, as far as the preview reads it. */
interface CloudflareConfig {
  bindings: PreviewBinding[];
  entry: string | null;
  notFoundHandling: NotFoundHandling | null;
  /** Builders that bind something the preview cannot serve, by name. */
  unsupported: string[];
  vars: LiteralObject;
}

/** What a `cf` config's builder binds, by builder name. */
const CF_BINDING_KINDS = {
  assets: "assets",
  d1: "d1",
  durableObject: "durable-object",
  json: "json",
  kv: "kv",
  r2: "r2",
  secret: "secret",
  secretsStoreSecret: "secret",
  text: "text",
} satisfies Record<string, PreviewBindingKind>;

/** `NAME: bindings.d1(…)` and `COUNTER: exports.durableObject(…)` in a `cf`
 * config — the namespace is what tells a binding from an export. */
const CF_CALL =
  /(?:(?<name>[\w$]+)\s*:\s*)?(?<namespace>bindings|exports)\.(?<builder>[\w$]+)\s*\(/gu;

const isText = (value: unknown): value is string => typeof value === "string";

/** A config value that names something: a non-empty string. */
const isFilled = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const isTextRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(isText);

const isManifestScripts = (value: unknown): value is { dev?: string } =>
  typeof value === "object" &&
  value !== null &&
  (!("dev" in value) || typeof value.dev === "string");

/** A `package.json`: `main`, `scripts.dev` and the two dependency maps. A
 * field of another type reads as absent. */
const isPackageManifest = (value: unknown): value is PackageManifest =>
  typeof value === "object" &&
  value !== null &&
  (!("main" in value) || typeof value.main === "string") &&
  (!("scripts" in value) || isManifestScripts(value.scripts)) &&
  (!("dependencies" in value) || isTextRecord(value.dependencies)) &&
  (!("devDependencies" in value) || isTextRecord(value.devDependencies));

const isWranglerAssets = <T>(value: T): value is T & WranglerAssets =>
  typeof value === "object" &&
  value !== null &&
  (!("binding" in value) || typeof value.binding === "string") &&
  (!("directory" in value) || typeof value.directory === "string") &&
  (!("not_found_handling" in value) ||
    typeof value.not_found_handling === "string");

const isNamedEntry = (value: unknown): value is WranglerNamedEntry =>
  typeof value === "object" &&
  value !== null &&
  (!("binding" in value) || typeof value.binding === "string") &&
  (!("bucket_name" in value) || typeof value.bucket_name === "string") &&
  (!("class_name" in value) || typeof value.class_name === "string") &&
  (!("database_name" in value) || typeof value.database_name === "string") &&
  (!("id" in value) || typeof value.id === "string") &&
  (!("migrations_dir" in value) || typeof value.migrations_dir === "string") &&
  (!("name" in value) || typeof value.name === "string");

const isNamedEntries = (value: unknown): value is WranglerNamedEntry[] =>
  Array.isArray(value) && value.every(isNamedEntry);

const isDurableObjects = (
  value: unknown
): value is { bindings?: WranglerNamedEntry[] } =>
  typeof value === "object" &&
  value !== null &&
  (!("bindings" in value) || isNamedEntries(value.bindings));

const isLiteralObject = (value: unknown): value is LiteralObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(isLiteralValue);

/** A `wrangler.json(c)`, with every field the preview reads proved to be the
 * type it is read as. */
const isWranglerConfig = (value: unknown): value is WranglerConfig =>
  typeof value === "object" &&
  value !== null &&
  (!("main" in value) || typeof value.main === "string") &&
  (!("assets" in value) ||
    typeof value.assets === "string" ||
    isWranglerAssets(value.assets)) &&
  (!("d1_databases" in value) || isNamedEntries(value.d1_databases)) &&
  (!("kv_namespaces" in value) || isNamedEntries(value.kv_namespaces)) &&
  (!("r2_buckets" in value) || isNamedEntries(value.r2_buckets)) &&
  (!("durable_objects" in value) || isDurableObjects(value.durable_objects)) &&
  (!("vars" in value) || isLiteralObject(value.vars));

/** The reading of one checkout's config files: the keys it holds, and the
 * text of the files that configure a backend. */
interface CheckoutFiles {
  keys: Set<string>;
  texts: Map<string, string>;
}

/** A parsed `package.json`. */
const readManifest = (text: string | undefined): PackageManifest => {
  if (text === undefined) {
    return {};
  }
  return parseJsonFile(text, isPackageManifest) ?? {};
};

/** A parsed `wrangler.json(c)`: `null` when the file is there and could not
 * be read as one. */
const readWrangler = (text: string | undefined): WranglerConfig | null =>
  text === undefined ? {} : parseJsonFile(text, isWranglerConfig);

/** The directory of a `404.html` in a generated Wrangler config: its presence
 * is what makes the fallback a 404 page rather than the index. */
const staticFallback = (
  keys: Set<string>,
  directory: string
): NotFoundHandling =>
  keys.has(`${directory.replace(/\/+$/u, "")}/404.html`)
    ? "404-page"
    : "single-page-application";

/** A `not_found_handling` value, when the config names one of the three
 * modes; anything else (a typo, a missing field) is absent. */
const asNotFoundHandling = (
  value: string | undefined
): NotFoundHandling | null =>
  value === "single-page-application" ||
  value === "404-page" ||
  value === "none"
    ? value
    : null;

/** What a `cf` config's binding builders declare, and the builders the
 * preview cannot serve. */
interface CloudflareBindingsRead {
  bindings: PreviewBinding[];
  unsupported: string[];
}

/** The parts of a `cf` config's `defineWorker(…)` the preview reads. */
interface CloudflareWorkerRead {
  notFoundHandling: NotFoundHandling | null;
  vars: LiteralObject;
}

/** The binding a `cf` builder declares, when the preview can serve it. */
const cfBindingOf = (
  kind: PreviewBindingKind,
  name: string,
  argumentText: string
): PreviewBinding | null => {
  const options = literalOf(argumentText);
  const binding: PreviewBinding = { kind, name };
  if (isLiteralObject(options)) {
    binding.resource =
      (isFilled(options.name) ? options.name : undefined) ??
      (isFilled(options.binding) ? options.binding : undefined) ??
      // `bindings.durableObject({ exportName })` names the Worker's export
      // holding the class, which is what the runtime looks up.
      (kind === "durable-object" && isFilled(options.exportName)
        ? options.exportName
        : undefined);
  }
  if (kind === "text" || kind === "json") {
    const value = kind === "json" ? options : literalOf(argumentText);
    if (value === undefined) {
      return null;
    }
    binding.value = value;
  }
  return binding;
};

/** A builder name the preview knows, as the key it is looked up by. */
const isCfBuilder = (
  builder: string
): builder is keyof typeof CF_BINDING_KINDS =>
  Object.hasOwn(CF_BINDING_KINDS, builder);

/** The binding kind a builder name declares, or null. */
const cfBindingKind = (builder: string): PreviewBindingKind | null =>
  isCfBuilder(builder) ? CF_BINDING_KINDS[builder] : null;

/** Every binding a `cf` config declares, and the builder names the preview
 * cannot serve. */
const readCloudflareBindings = (text: string): CloudflareBindingsRead => {
  const bindings: PreviewBinding[] = [];
  const unsupported: string[] = [];
  for (const call of scanCalls(text, CF_CALL)) {
    const { argumentText, builder, name, namespace } = call;
    // `exports.durableObject(…)` declares a class; it binds nothing.
    if (name === null || namespace !== "bindings") {
      continue;
    }
    const kind = cfBindingKind(builder);
    if (kind === null) {
      unsupported.push(`${name} (${builder})`);
      continue;
    }
    const binding = cfBindingOf(kind, name, argumentText);
    if (binding === null) {
      unsupported.push(`${name} (${builder})`);
      continue;
    }
    bindings.push(binding);
  }
  return { bindings, unsupported };
};

/** The module a `cf` config's `entrypoint` names: the import whose local name
 * the property carries (`entrypoint: module`, or the shorthand `entrypoint`
 * beside `import * as entrypoint from "./index.ts"`). */
const readCloudflareEntry = (text: string): string | null => {
  const args = callArguments(text, "defineWorker");
  if (args === null) {
    return null;
  }
  const property = /(?:^|[{,\s])entrypoint\s*(?::\s*(?<local>[\w$]+))?/u.exec(
    args
  );
  const wanted = property?.groups?.local ?? "entrypoint";
  const found = findImports(text).find((entry) => entry.local === wanted);
  if (found === undefined || !found.specifier.startsWith(".")) {
    return null;
  }
  return found.specifier.replace(/^\.\//u, "");
};

/** The `assets` and `vars` a `cf` config's `defineWorker(…)` declares. The
 * assets *directory* comes from the build, so only the fallback behaviour is
 * here. */
const readCloudflareWorker = (text: string): CloudflareWorkerRead => {
  const args = callArguments(text, "defineWorker");
  const options = args === null ? undefined : literalOf(args.trim());
  if (!isLiteralObject(options)) {
    return { notFoundHandling: null, vars: {} };
  }
  const { assets, vars } = options;
  const handling = isLiteralObject(assets)
    ? asNotFoundHandling(
        isText(assets.notFoundHandling) ? assets.notFoundHandling : undefined
      )
    : null;
  return {
    notFoundHandling: handling,
    vars: isLiteralObject(vars) ? vars : {},
  };
};

/** Everything a `cf` config declares, in one read. */
const readCloudflare = (text: string | undefined): CloudflareConfig => {
  if (text === undefined) {
    return {
      bindings: [],
      entry: null,
      notFoundHandling: null,
      unsupported: [],
      vars: {},
    };
  }
  const worker = readCloudflareWorker(text);
  const entry = readCloudflareEntry(text);
  return {
    ...readCloudflareBindings(text),
    entry,
    notFoundHandling: worker.notFoundHandling,
    vars: worker.vars,
  };
};

/** Every binding a Wrangler config declares — the lists, then the plain
 * `vars`. */
const readWranglerBindings = (config: WranglerConfig): PreviewBinding[] => {
  const bindings: PreviewBinding[] = [];
  const named = (
    entries: WranglerNamedEntry[] | undefined,
    kind: PreviewBindingKind,
    resource: "bucket_name" | "database_name" | "id"
  ): void => {
    for (const entry of entries ?? []) {
      if (entry.binding !== undefined) {
        const binding: PreviewBinding = {
          kind,
          name: entry.binding,
          resource: entry[resource],
        };
        if (kind === "d1" && entry.migrations_dir !== undefined) {
          binding.migrationsDir = entry.migrations_dir;
        }
        bindings.push(binding);
      }
    }
  };
  named(config.d1_databases, "d1", "database_name");
  named(config.kv_namespaces, "kv", "id");
  named(config.r2_buckets, "r2", "bucket_name");
  for (const entry of config.durable_objects?.bindings ?? []) {
    if (entry.name !== undefined) {
      bindings.push({
        kind: "durable-object",
        name: entry.name,
        resource: entry.class_name,
      });
    }
  }
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    bindings.push({ kind: "text", name, value });
  }
  return bindings;
};

/** The keys a checkout holds, normalised to checkout-relative, and the text
 * of the files that configure a backend. */
const collectFiles = (files: ReadonlyMap<string, string>): CheckoutFiles => {
  const keys = new Set<string>();
  const texts = new Map<string, string>();
  for (const [rawKey, text] of files) {
    const key = rawKey.replace(/^\/+/u, "").replace(/^home\/project\//u, "");
    keys.add(key);
    if (CONFIG_FILES.some((file) => file === key)) {
      texts.set(key, text);
    }
  }
  return { keys, texts };
};

/** The `assets` object of a Wrangler config, when it uses the object form. */
const wranglerAssetsOf = (wrangler: WranglerConfig): WranglerAssets | null => {
  const { assets } = wrangler;
  return assets !== undefined && isWranglerAssets(assets) ? assets : null;
};

/** The assets directory: what the config names, or the first build output
 * holding an `index.html`. */
const readAssets = (
  keys: Set<string>,
  wrangler: WranglerConfig
): string | null => {
  const declared = wranglerAssetsOf(wrangler);
  if (declared?.directory !== undefined) {
    return declared.directory;
  }
  if (isText(wrangler.assets)) {
    return wrangler.assets;
  }
  return STATIC_DIRS.find((dir) => keys.has(`${dir}/index.html`)) ?? null;
};

/** The Worker entry: the config that names one most precisely first, then the
 * `src/index.ts` convention. */
const readEntry = (
  keys: Set<string>,
  manifest: PackageManifest,
  wrangler: WranglerConfig,
  cloudflare: CloudflareConfig
): string | null => {
  const named = wrangler.main ?? cloudflare.entry ?? manifest.main ?? null;
  if (named !== null) {
    return named.replace(/^\.\//u, "");
  }
  return keys.has("src/index.ts") ? "src/index.ts" : null;
};

/** The notes a checkout's config earns: the builders the preview cannot
 * serve, and the entries it could not read. */
const configNotes = (
  texts: Map<string, string>,
  cloudflare: CloudflareConfig,
  wranglerFile: boolean,
  parsedWrangler: WranglerConfig | null
): string[] => {
  const notes: string[] = [];
  if (wranglerFile && parsedWrangler === null) {
    notes.push("the wrangler config could not be read");
  }
  notes.push(
    ...cloudflare.unsupported.map(
      (skipped) => `binding ${skipped} is not available in Preview`
    )
  );
  const cloudflareText = texts.get("cloudflare.config.ts");
  if (
    cloudflareText !== undefined &&
    cloudflare.entry === null &&
    callArguments(cloudflareText, "defineWorker") !== null
  ) {
    notes.push("cloudflare.config.ts: the entrypoint could not be read");
  }
  return notes;
};

/** Everything the runtime needs from a checkout, read out of the config files
 * the checkout holds. Keys may be checkout-relative or absolute. */
export const previewConfig = (
  files: ReadonlyMap<string, string>
): PreviewConfig => {
  const { keys, texts } = collectFiles(files);
  const manifest = readManifest(texts.get("package.json"));
  const wranglerFile =
    texts.has("wrangler.json") || texts.has("wrangler.jsonc");
  const parsedWrangler = readWrangler(
    texts.get("wrangler.json") ?? texts.get("wrangler.jsonc")
  );
  const wrangler = parsedWrangler ?? {};
  const cloudflare = readCloudflare(texts.get("cloudflare.config.ts"));
  const entry = readEntry(keys, manifest, wrangler, cloudflare);
  const assets = readAssets(keys, wrangler);
  const assetsField = wranglerAssetsOf(wrangler);
  const bindings = [
    ...cloudflare.bindings,
    ...Object.entries(cloudflare.vars).map(([name, value]) => ({
      kind: "text" as const,
      name,
      value,
    })),
    ...readWranglerBindings(wrangler),
  ];
  const assetsBinding = assetsField?.binding;
  if (
    assetsBinding !== undefined &&
    !bindings.some((binding) => binding.name === assetsBinding)
  ) {
    bindings.push({ kind: "assets", name: assetsBinding });
  }
  return {
    assets,
    bindings,
    dependencies: manifest.dependencies ?? {},
    dev: manifest.scripts?.dev ?? null,
    devDependencies: manifest.devDependencies ?? {},
    entry,
    hasIndexHtml: keys.has("index.html"),
    hasViteConfig: [...keys].some((key) => VITE_CONFIG.test(key)),
    notFoundHandling:
      (assets === null ? null : staticFallback(keys, assets)) ??
      asNotFoundHandling(assetsField?.not_found_handling) ??
      cloudflare.notFoundHandling ??
      "single-page-application",
    unreadable: configNotes(texts, cloudflare, wranglerFile, parsedWrangler),
  };
};

/** The dependencies of `config` that only run through a native binary. */
export const nativeDeps = (config: PreviewConfig): string[] =>
  NATIVE_ONLY_DEPS.filter(
    (name) =>
      config.dependencies[name] !== undefined ||
      config.devDependencies[name] !== undefined
  );
