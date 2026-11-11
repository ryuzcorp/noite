import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { voidIlha } from "@ilha/void/plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { voidPlugin } from "void";

import { CURATED_SHIKI_LANGS } from "./src/lib/shiki-langs.ts";
import { RUN_WORKER_FIRST } from "./void.config.ts";

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
  "@pierre/trees",
  "better-auth/client",
  "better-auth/client/plugins",
  "effect/Schema",
  "effect/reactivity/Atom",
  "ilha/jsx-dev-runtime",
  "scule",
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

/** The app root: this config file's own directory, which is Vite's default
 * `root` and where `src/` lives (Void generates the HTML shell and entries). */
const APP_ROOT = import.meta.dirname;

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
    // The same rule list as `void.config.ts` (`RUN_WORKER_FIRST`, imported
    // above): celld serves `/assets/*` from its own resolver — with the
    // `public/_headers` cache policy — instead of invoking the Worker, where
    // Void's pages fallback would fetch them inside the app (and its 15 s
    // action bound). Void's own `dist/ssr/wrangler.json` is rewritten to
    // `["/**"]` by its asset-bypass normalizer, so this file is the only place
    // the deployed rule survives.
    config["assets"] = {
      ...ssrAssets,
      directory: "client",
      run_worker_first: [...RUN_WORKER_FIRST],
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

export default defineConfig({
  define: { __CONTROL_BUILD__: JSON.stringify(controlBuild()) },
  environments: {
    void_worker: { optimizeDeps: { include: [...WORKER_DEPS] } },
  },
  optimizeDeps: { include: [...LATE_DEPS] },
  plugins: [
    curatedShikiLangs(),
    // Void owns the worker entry (middleware → routes → pages → static
    // assets), generated from `src/middleware/` + `src/routes/` plus
    // `void.config.ts` (`sourceDir: "src"`) — no wrangler file, no
    // `src/worker.ts`. `voidIlha()` renders Void pages with ilha. Void has
    // no action timeout, so the 15 s per-route bound lives in
    // `src/middleware/01-timeout.ts` (JSON 504, stream/R2/static exempt).
    // Keep dev D1 where the Oxide/Cloudflare plugin kept it
    // (`.wrangler/state/v3/d1/...`), so existing local accounts survive the
    // migration — Void's default (`.void/`) starts a fresh database.
    voidPlugin({ persistTo: ".wrangler/state" }),
    voidIlha(),
    tailwindcss(),
    // Deploy-root celld config + `.dev.vars` stripping, after Void's emit.
    emitCelldConfig(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    allowedHosts: true,
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
