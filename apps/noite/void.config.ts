// Worker config for Void (https://void.cloud) — the control UI's single
// source for its Worker: bindings, assets, defaults. `voidPlugin()` reads it
// (edits need a dev server restart) and the build emits
// `dist/ssr/wrangler.json`, from which `vite.config.ts` (`emitCelldConfig`)
// derives the deploy-root `dist/wrangler.json` the runner deploys with celld.
//
// Serving contract (runner `ensure_deployed`, celld `CELLD_KEYS`): name
// `noite-control`, compat date `2026-09-01`, worker-first routing with
// `not_found_handling "none"` (a missing hashed chunk 404s instead of
// serving the document), the D1 `DB` keyed by name (no `database_id`), the
// `ASSETS` binding declared (celld does not inject it), and `vars` defaults
// the runner overwrites at deploy time. Isolation + cache headers mirror
// `public/_headers` (celld reads that file too); Void applies
// `routing.headers` to assets, SSR pages and API responses.
import { defineConfig } from "void/config";

/** Which paths start the Worker. `/assets/*` is served by the platform.
 *
 * Void's pages fallback answers a router miss (`/assets/*` never matches a
 * route) by fetching `env.ASSETS` *inside* the Hono app — so a worker-bound
 * asset request runs the whole middleware chain (better-auth, the per-request
 * D1 `ensureDb` read, the rate limit) and, crucially, sits inside
 * `src/middleware/01-timeout.ts`'s 15 s action bound. An asset read that
 * outlives the bound is answered with that middleware's JSON 504 instead of
 * the file, which is a hydration failure with no retry: the island bundle
 * never executes. Excluding the fingerprinted bundle from worker-first makes
 * celld serve it from its own asset resolver (same `_headers` policy: the
 * `/assets/*` immutable cache rule and the isolation headers) without
 * invoking the Worker at all, so no action timeout, session read or D1 read
 * can ever stand between the browser and its chunks. A *missing* file still
 * falls through to the Worker (celld answers only hits at the edge of this
 * rule), so the app's 404 handling is unchanged.
 *
 * `vite.config.ts` (`emitCelldConfig`) writes this same list into the deploy
 * config; Void's own build rewrites `dist/ssr/wrangler.json` to `["/**"]`. */
export const RUN_WORKER_FIRST: string[] = ["/**", "!/assets/*"];

export default defineConfig({
  cloudflare: {
    assets: {
      binding: "ASSETS",
      not_found_handling: "none",
      run_worker_first: RUN_WORKER_FIRST,
    },
    d1_databases: [{ binding: "DB", database_name: "noite-control" }],
    name: "noite-control",
  },
  // The document shell `index.html` used to carry (Void generates the shell
  // now): language, favicon and viewport on every page, under each page's
  // own title.
  head: {
    htmlAttrs: { lang: "en" },
    link: [{ href: "/favicon.svg", rel: "icon", type: "image/svg+xml" }],
    meta: [
      { charset: "utf-8" },
      { content: "width=device-width, initial-scale=1.0", name: "viewport" },
    ],
  },
  routing: {
    headers: {
      "/*": [
        "Cross-Origin-Embedder-Policy: require-corp",
        "Cross-Origin-Opener-Policy: same-origin",
        "Cross-Origin-Resource-Policy: same-origin",
      ],
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    },
  },
  // The web root is `src`: Void scans `src/routes`, `src/middleware` (and,
  // from the pages slice, `src/pages`) there. Project files (this config,
  // `vite.config.ts`, `package.json`, `public/`) stay at the project root.
  sourceDir: "src",
  worker: {
    compatibility_date: "2026-09-01",
    vars: {
      BASE_DOMAIN: "noite.localhost",
      RUNNER_URL: "http://127.0.0.1:8080",
    },
  },
});
