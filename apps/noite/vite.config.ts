import { execFileSync } from "node:child_process";

import { cloudflare } from "@cloudflare/vite-plugin";
import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { withOxide } from "oxidejs/wrangler";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

import { controlEnv, hydrateControlEnv } from "./src/lib/control-env.ts";
import { CURATED_SHIKI_LANGS } from "./src/lib/shiki-langs.ts";

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
      middleware: ["./src/middleware/db.ts", "@ilha/router/ssr"],
    }),
    // oxide() loads cloudflare.config.ts (worker preset auto-detected) and
    // withOxide() hands it to the Cloudflare plugin: no wrangler file.
    cloudflare(withOxide()),
    pages(),
    tailwindcss(),
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
