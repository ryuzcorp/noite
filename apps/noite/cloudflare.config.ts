// Worker config for the `cf` CLI (https://github.com/cloudflare/cf) — the
// control UI's single source for its Worker: bindings, assets, defaults.
// oxide() loads it (Node ≥ 22.18; edits need a dev server restart) and
// withOxide() hands it to the Cloudflare plugin, and the build emits
// `dist/wrangler.json`, which the runner deploys with celld.
import { bindings, defineConfig, defineWorker } from "cf/config";

const worker = defineWorker({
  assets: {
    // Oxide's worker SPA-falls-back document navigations itself. Keep Assets
    // on real 404s — `single-page-application` would return index.html
    // (text/html) for a missing `/assets/*.js` and break hashed client
    // bundles after a deploy. Worker first so every path goes through it.
    notFoundHandling: "none",
    runWorkerFirst: true,
  },
  compatibilityDate: "2026-09-01",
  entrypoint: "./src/worker.ts",
  env: {
    // Oxide's worker wrapper serves the SPA through env.ASSETS; unlike
    // Cloudflare, celld does not inject it, so it is declared.
    ASSETS: bindings.assets(),
    // Non-secret defaults (deploy env / compose env override them; secrets
    // such as BETTER_AUTH_SECRET and RUNNER_TOKEN never live here).
    BASE_DOMAIN: bindings.text("localhost"),
    // celld keys D1 by name (no database_id).
    DB: bindings.d1({ name: "noite-control" }),
    // Runner REST base: same container (SPEC, Process tree).
    RUNNER_URL: bindings.text("http://127.0.0.1:8080"),
  },
  name: "noite-control",
});

export default defineConfig({ worker });
