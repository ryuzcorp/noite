import { execFileSync } from "node:child_process";

import { voidIlha } from "@ilha/void/plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { voidPlugin } from "void";

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
