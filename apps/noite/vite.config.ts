import { execFileSync } from "node:child_process";

import {
  convertToWranglerConfig,
  loadAndParseConfig,
} from "@cloudflare/config";
import { cloudflare } from "@cloudflare/vite-plugin";
import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { withOxide } from "oxidejs/wrangler";
import type { DurableWranglerConfig } from "oxidejs/wrangler";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

import { controlEnv, hydrateControlEnv } from "./src/lib/control-env.ts";

hydrateControlEnv();

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

/** Resource opt T6.1: the shiki ids the source browser can request
 * (mirrors CURATED_LANGS in src/lib/source-browser.tsx; `text` is
 * built into shiki and never imported as a module). */
const CURATED_SHIKI_LANGS = {
  css: true,
  html: true,
  javascript: true,
  json: true,
  jsonc: true,
  jsx: true,
  markdown: true,
  sql: true,
  toml: true,
  tsx: true,
  typescript: true,
  yaml: true,
  zsh: true,
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
    if (Object.hasOwn(CURATED_SHIKI_LANGS, lang)) {
      return null;
    }
    // One shared id: every excluded grammar resolves to the same empty
    // module, so the bundler emits a single tiny chunk, not hundreds.
    return "\0shiki-lang-stub";
  },
});

/** The Worker's wrangler-shaped config, converted from `cloudflare.config.ts`
 * (the `cf` CLI config). Vite's Cloudflare plugin and withOxide's durable
 * bindings build on this shape, so there is no wrangler file to keep in step. */
const loadWorkerConfig = async (): Promise<DurableWranglerConfig> => {
  const { result } = await loadAndParseConfig("cloudflare.config.ts", {
    isPreview: false,
    mode: "production",
  });
  if (!result.success) {
    throw new Error(
      `cloudflare.config.ts is invalid:\n${result.error.message}`
    );
  }
  // SAFETY: convertToWranglerConfig yields the wrangler JSON shape; DurableWranglerConfig types only the durable slice the plugin customizer reads.
  return convertToWranglerConfig(result.data) as DurableWranglerConfig;
};

const workerConfig = await loadWorkerConfig();

export default defineConfig({
  define: { __CONTROL_BUILD__: JSON.stringify(controlBuild()) },
  plugins: [
    curatedShikiLangs(),
    oxide({
      actions: {
        sameOrigin: true,
        // Below the edge's 30 s response_header_timeout: a stuck action
        // answers with a JSON-RPC error instead of an edge 504.
        timeout: 15_000,
        transport: "http",
      },
      // SAFETY: controlEnv is a plain-object env bag; oxide only reads known keys off it, so casting to its `never`-indexed env type is safe (the bag holds only strings + durable bindings written before vite boot).
      env: controlEnv as never,
      imports: [],
      middleware: [
        "./src/middleware/db.ts",
        "./src/middleware/api.ts",
        "@ilha/router/ssr",
      ],
      preset: "worker",
    }),
    pages(),
    tailwindcss(),
    cloudflare(
      withOxide({
        config: (c: DurableWranglerConfig) => {
          // The plugin starts from an empty config (no wrangler file):
          // `assets` (with its SPA fallback and ASSETS binding), D1, vars and
          // the entrypoint all come from cloudflare.config.ts.
          Object.assign(c, workerConfig);
        },
      })
    ),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    allowedHosts: true,
    host: true,
    port: Number(process.env.PORT ?? 8080),
    // Runtime state lives inside the project root: local D1/R2/DO sqlite
    // under .wrangler and build output under dist. Every deploy status
    // write flips those files, and the default watcher (everything except
    // node_modules/.git) answers with a full document reload. Ignore them —
    // source edits still HMR normally.
    watch: {
      ignored: ["**/.wrangler/**", "**/dist/**"],
    },
  },
});
