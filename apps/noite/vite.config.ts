import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { voidIlha } from "@ilha/void/plugin";
import { nodepod } from "@r1ck404/nodepod/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { voidPlugin } from "void";

import {
  POD_HOST_DEV_JS,
  POD_HOST_HEADERS,
  podHostHtml,
} from "./src/lib/pod-host-document.ts";
import {
  isControlDeniedAsset,
  isPreviewHost,
  POD_HOST_HTML_PATH,
  PREVIEW_HOST_ASSETS,
} from "./src/lib/preview-host.ts";
import { CURATED_SHIKI_LANGS } from "./src/lib/shiki-langs.ts";

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf-8" }).trim();

/** Build id for `/health`: the git sha (plus `-dirty` for an unclean tree),
 * else the build time — so a deploy is always distinguishable from the
 * previous one without a hand-bumped number. */
const controlBuild = (): string => {
  try {
    const sha = git("rev-parse", "--short", "HEAD");
    return git("status", "--porcelain", "--", ".") ? `${sha}-dirty` : sha;
  } catch {
    return new Date().toISOString();
  }
};

/** Only the curated shiki grammars ship. @pierre/diffs resolves every other
 * language through a dynamic `import("@shikijs/langs/*")`, which the bundler
 * would otherwise emit as one chunk per grammar (~25 MB across client+ssr).
 * The source browser coerces every filename to the curated set or `text`
 * before pierre ever resolves, so these stubs are unreachable at runtime. */
const curatedShikiLangs = (): Plugin => ({
  enforce: "pre",
  load(id: string) {
    if (id === "\0shiki-lang-stub") {
      return "export default {};\n";
    }
    return null;
  },
  name: "curated-shiki-langs",
  resolveId(source: string) {
    if (!source.startsWith("@shikijs/langs/")) {
      return null;
    }
    const lang = source.slice("@shikijs/langs/".length);
    if (CURATED_SHIKI_LANGS.includes(lang)) {
      return null;
    }
    // One shared id: every excluded grammar resolves to the same empty
    // module, so the bundler emits a single tiny chunk, not hundreds.
    return "\0shiki-lang-stub";
  },
});

/** Cross-origin isolation for the whole control UI (documents, modules,
 * worker scripts and static assets alike). Nodepod's workspace and the
 * TypeScript language service pass `SharedArrayBuffer` to workers, which a
 * browser only exposes in a cross-origin-isolated agent cluster.
 *
 * `require-corp` rather than `credentialless`: the UI loads no third-party
 * subresource (avatars are initials, docs links are plain navigations), so
 * nothing legitimate needs the looser policy. Production mirrors this in
 * `public/_headers` (celld serves the very same files). */
const ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

/** `server.headers` only reach Vite's own middlewares (HTML, static, the
 * transform pipeline). A plugin that answers a request itself — Nodepod's
 * `__sw__.js` / `__worker__.js` / bridge middleware — would miss them, so
 * stamp every dev response at the top of the connect stack. Registered
 * before `nodepod()` in the plugin list, so it runs first. */
const crossOriginIsolation = (): Plugin => ({
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
        response.setHeader(name, value);
      }
      next();
    });
  },
  name: "cross-origin-isolation",
});

/** The pod asset paths, for the dev server's own routing decision (see
 * `podHostFrame` below): a plain membership table over the list the production
 * router and Caddy share. */
const POD_ASSETS: Record<string, true> = Object.fromEntries(
  PREVIEW_HOST_ASSETS.map((assetPath) => [assetPath, true] as const)
);

/** The app root: this config file's own directory, which is Vite's default
 * `root` and where `src/` lives (Void generates the HTML shell and entries). */
const APP_ROOT = import.meta.dirname;

/** `src/pod-host/main.ts`, the whole pod — Nodepod, the checkout and the
 * shell — as one client-side entry. */
const POD_HOST_ENTRY = "noite-pod-host";
const POD_HOST_ENTRY_MODULE = "src/pod-host/main.ts";

/** One response the dev server serves for the pod host document. */
interface PodHostFile {
  body: string;
  type: string;
}

/** The pod host document for `pathname`, the same response
 * `src/http/routes/nodepod.ts` returns in production, or null for every other
 * path (the bundle and Nodepod's own assets come from Vite's own pipeline in
 * dev, from the built assets in production).
 *
 * Dev points the document at the module graph (`POD_HOST_DEV_JS`) instead of
 * the built bundle: not built yet, and HMR then reaches the frame. */
const podHostFile = (pathname: string): PodHostFile | null => {
  if (pathname === POD_HOST_HTML_PATH) {
    return {
      body: podHostHtml(POD_HOST_DEV_JS),
      type: "text/html; charset=utf-8",
    };
  }
  return null;
};

/** The frame entry, built with the control UI's client bundle: one extra entry
 * and the one file name that cannot carry a content hash, because the pod
 * host serves it at the fixed path `/noite-pod-host.js` (`POD_HOST_JS_PATH`) —
 * the document is a string, so nothing can interpolate a hashed name into it.
 * Every other entry keeps Vite's hashed name.
 *
 * Client environment only: Void's worker entry is generated (no source entry),
 * and the pages client entry comes from `voidIlha()`'s pages plugin. */
const podHostEntry = (): Plugin => ({
  applyToEnvironment: (environment) => environment.name === "client",
  configEnvironment(environmentName) {
    if (environmentName !== "client") {
      return;
    }
    return {
      build: {
        rollupOptions: {
          input: {
            [POD_HOST_ENTRY]: path.resolve(APP_ROOT, POD_HOST_ENTRY_MODULE),
          },
          output: {
            entryFileNames: ({ name: chunkName }) =>
              chunkName === POD_HOST_ENTRY
                ? "noite-pod-host.js"
                : "assets/[name]-[hash].js",
          },
        },
      },
    };
  },
  name: "pod-host-entry",
});

/** The dev server's half of the pod assets' routing, which production splits
 * between the router (`src/http/routes/nodepod.ts`) and Caddy's pod-host site:
 *
 * - the pod host document is the app's own response, with `POD_HOST_HEADERS`,
 *   on the app's pod host only;
 * - every other pod asset path answers 404 on any other host, so the control
 *   UI's origin serves neither a worker script nor a service worker. Nodepod's
 *   own middleware is host-agnostic, so this has to run before it (the plugin
 *   sits ahead of `nodepodClient` below). */
const podHostFrame = (): Plugin => ({
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = (request.url ?? "").split("?")[0] ?? "";
      if (isPreviewHost(request.headers.host ?? null)) {
        if (!(pathname in POD_ASSETS)) {
          // Nodepod's own assets and the preview bridge: not this plugin's.
          next();
          return;
        }
        const file = podHostFile(pathname);
        if (file === null) {
          // Nodepod's own assets, on the host that serves them.
          next();
          return;
        }
        for (const [name, value] of Object.entries(POD_HOST_HEADERS)) {
          response.setHeader(name, value);
        }
        response.setHeader("Content-Type", file.type);
        response.statusCode = 200;
        response.end(file.body);
        return;
      }
      // The control UI's own host: nothing that could put a worker or a
      // registerable service worker there answers (see
      // `CONTROL_HOST_DENIED_ASSETS`).
      if (isControlDeniedAsset(pathname)) {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }
      next();
    });
  },
  name: "pod-host-frame",
});

/** Deps only a dynamic `import()` or a late-loaded feature reaches. Vite's
 * dep-optimizer scan walks static imports only, so the browser "discovers"
 * these when the feature first loads (Code mode's pierre bundle, the terminal,
 * the language-service worker); the discovery re-optimizes the environment and
 * every client full-reloads — mid-session, taking the in-flight actions with
 * it. Naming them here bundles them up front, so discovery never fires then. */
const LATE_DEPS = [
  "@better-auth/api-key/client",
  "@better-auth/passkey/client",
  "@pierre/diffs",
  "@pierre/diffs/edit",
  "@pierre/highlights",
  "@pierre/highlights/themes/pierre-dark",
  "@pierre/highlights/themes/pierre-light",
  "@pierre/trees",
  "better-auth/client",
  "better-auth/client/plugins",
  "effect/Schema",
  "effect/reactivity/Atom",
  "ghostty-web",
  "ilha/jsx-dev-runtime",
  "scule",
  "typescript-ls",
] as const;

/** Deps the `void_worker` environment reaches while SSR-rendering and serving
 * API routes. The worker env optimizes lazily like the client did before
 * `LATE_DEPS`: the first request to touch one re-optimizes that environment
 * and reloads the worker mid-boot, so a cold start serves 500s until the
 * discoveries settle. Naming them here prebundles the worker up front, so a
 * cold boot does no re-optimization. The set mirrors what the dev log reports
 * as `(void_worker) dependencies optimized` on a cold boot; extend it the
 * same way when a new server import shows up there. */
const WORKER_DEPS = [
  "@better-auth/api-key/client",
  "@better-auth/passkey/client",
  "@data-slot/resizable",
  "@effect/sql-d1",
  "better-auth/client",
  "better-auth/client/plugins",
  "effect/Cache",
  "effect/Effect",
  "effect/Schema",
  "effect/reactivity/Atom",
  "effect/sql/SqlClient",
  "kysely",
  "kysely-d1",
  "paranorm",
  "scule",
] as const;

/** Nodepod's Vite plugin, scoped to the client environment. Its
 * `generateBundle` has no environment filter, so as-is it also drops the four
 * runtime assets into the SSR output (`dist/ssr`), which celld never serves —
 * the deployment's asset directory is `dist/client`. Dev is unaffected (the
 * client is the only environment that answers those paths). */
const nodepodClient = (): Plugin => ({
  ...nodepod(),
  applyToEnvironment: (environment) => environment.name === "client",
});

/** Top-level keys `celld deploy` accepts. Mirrors `CELLD_KEYS` in
 * `apps/runner/src/host/build_output.rs` — an unknown key fails the deploy,
 * so anything Void emits outside this set is dropped, never passed through. */
const CELLD_KEYS = [
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "queues",
  "workflows",
  "r2_buckets",
] as const;
/** One D1 binding entry in Void's generated `dist/ssr/wrangler.json`. */
interface D1DatabaseEntry {
  binding?: string;
  database_name?: string;
  migrations_dir?: string;
}

/** Write the deploy-root `dist/wrangler.json` celld deploys, derived from
 * Void's own `dist/ssr/wrangler.json` (never handwritten): `main` rewrites
 * to deploy-root-relative `ssr/…`, the asset directory to `client`, and
 * `vars` to `{}` (the runner patches the real vars at deploy time).
 * Local-only `.dev.vars` files are removed from `dist/` and `dist/ssr/` so
 * they never ship inside the bundle (the Dockerfile strips them too), and
 * Void's Cloudflare-only `dist/client/.assetsignore` is removed: `celld
 * deploy` refuses it outright, and its two entries need no replacement —
 * `wrangler.json` is celld's config surface (never an asset) and `.dev.vars`
 * is removed just above.
 * Last in the plugin list so its `closeBundle` runs after Void's emit; when
 * the SSR bundle hasn't closed yet it does nothing and the SSR close writes. */
const emitCelldConfig = (): Plugin => ({
  closeBundle() {
    const dist = path.resolve(APP_ROOT, "dist");
    const dirs = [dist, path.join(dist, "ssr")];
    for (const dir of dirs) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry === ".dev.vars" || entry.startsWith(".dev.vars.")) {
          rmSync(path.join(dir, entry), { force: true });
        }
      }
    }
    rmSync(path.join(dist, "client", ".assetsignore"), { force: true });
    let emitted: string;
    try {
      emitted = readFileSync(path.join(dist, "ssr", "wrangler.json"), "utf-8");
    } catch {
      return;
    }
    /* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- the build boundary: Void's generated wrangler.json is JSON whose keys are celld's config surface, so its shape is an open dictionary and this is the one place that takes it apart. Every field is checked here before it is read, and only CELLD_KEYS allowlisted entries leave this section. */
    const ssr = JSON.parse(emitted) as Record<string, unknown>;
    const ssrAssets =
      typeof ssr["assets"] === "object" && ssr["assets"] !== null
        ? (ssr["assets"] as Record<string, unknown>)
        : {};
    const ssrMain =
      typeof ssr["main"] === "string" && ssr["main"] ? ssr["main"] : "index.js";
    const config: Record<string, unknown> = {};
    for (const key of CELLD_KEYS) {
      if (key in ssr) {
        config[key] = ssr[key];
      }
    }
    config["main"] = `ssr/${ssrMain}`;
    // celld reads `run_worker_first` only as a boolean, but Void's build
    // forces the pattern-array form whenever routing rules exist (ours do:
    // the isolation headers). Coerce it here — this file is celld's config
    // surface only; `dist/ssr/wrangler.json` keeps Void's own form. Without
    // worker-first, celld serves every existing static file itself and the
    // worker (with the pod-host gate) never sees it.
    config["assets"] = {
      ...ssrAssets,
      directory: "client",
      run_worker_first: true,
    };
    // D1 is keyed by name: drop Void's default `migrations_dir` (it points
    // at a directory that does not exist; schema migrates at runtime via
    // `ensureDb`, never through wrangler migrations).
    if (Array.isArray(config["d1_databases"])) {
      for (const entry of config["d1_databases"]) {
        if (typeof entry === "object" && entry !== null) {
          // SAFETY: d1_databases entries are binding objects; only the optional migrations_dir is removed.
          delete (entry as Partial<D1DatabaseEntry>)["migrations_dir"];
        }
      }
    }
    /* oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */
    config["vars"] = {};
    writeFileSync(
      path.join(dist, "wrangler.json"),
      `${JSON.stringify(config, null, 2)}\n`
    );
  },
  name: "celld-config",
});

/** Nodepod registers its browser `RuntimeHost` as a top-level side effect of
 * an internal chunk (`dist/index-<hash>.js`), but its package.json
 * `sideEffects` list names only the entry files, so the production bundler
 * tree-shakes the registration away and every boot fails with "No
 * RuntimeHost registered" (dev, which doesn't tree-shake, works). Mark the
 * package's own modules side-effectful. */
const nodepodSideEffects = (): Plugin => ({
  name: "nodepod-side-effects",
  transform: {
    filter: { id: /[\\/]@r1ck404[\\/]nodepod[\\/]dist[\\/]/u },
    handler: () => ({ moduleSideEffects: true }),
  },
});

export default defineConfig({
  define: { __CONTROL_BUILD__: JSON.stringify(controlBuild()) },
  environments: {
    void_worker: { optimizeDeps: { include: [...WORKER_DEPS] } },
  },
  optimizeDeps: { include: [...LATE_DEPS] },
  plugins: [
    crossOriginIsolation(),
    curatedShikiLangs(),
    podHostFrame(),
    // The pod host entry: the whole workspace, built as a second client entry
    // at the fixed path `/noite-pod-host.js` (see `podHostEntry`).
    podHostEntry(),
    // Nodepod's static runtime: `__sw__.js`, `__worker__.js` and the dead
    // `__nodepod_bridge__` pair. Dev serves them from the plugin's middleware;
    // the build emits them next to the client assets (dist/client) so celld
    // serves them with the rest of the bundle. This sits ahead of Void's
    // worker entry, whose dev HTML handling answers 404 to iframe-destination
    // navigations — the pod host document would never load if it ran first.
    // It answers only those paths (plus every pod-host document), so nothing
    // else changes hands, and `podHostFrame` above has already decided the
    // pod's own paths by host.
    nodepodClient(),
    // Void owns the worker entry (middleware → routes → pages → static
    // assets), generated from `src/middleware/` + `src/routes/` plus
    // `void.config.ts` (`sourceDir: "src"`) — no wrangler file, no
    // `src/worker.ts`. `voidIlha()` renders Void pages with ilha. Void has
    // no action timeout, so the 15 s per-route bound lives in
    // `src/middleware/01-timeout.ts` (JSON 504, stream/R2/archive exempt).
    voidPlugin(),
    voidIlha(),
    nodepodSideEffects(),
    tailwindcss(),
    // Deploy-root celld config + `.dev.vars` stripping, after Void's emit.
    emitCelldConfig(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    allowedHosts: true,
    // The isolation policy for Vite's own middlewares; the `crossOriginIsolation`
    // plugin above covers the responses Vite does not pass these to (Nodepod's
    // assets and any other direct handler).
    headers: { ...ISOLATION_HEADERS },
    host: true,
    port: Number(process.env.PORT ?? 8080),
    // Runtime state lives inside the project root: Void local state under
    // .void and build output under dist. Every deploy status write flips
    // those files, and the default watcher (everything except
    // node_modules/.git) answers with a full document reload. Ignore them —
    // source edits still HMR normally.
    watch: {
      ignored: ["**/.void/**", "**/.wrangler/**", "**/dist/**"],
    },
  },
});
