// Worker config for the `cf` CLI (https://github.com/cloudflare/cf) — the
// control UI's single source for its Worker: bindings, assets, defaults.
// `vite.config.ts` converts it to the wrangler shape the Cloudflare plugin and
// withOxide (durable bindings scanned from ops.server.ts) build on, and the
// build emits `dist/wrangler.json`, which the runner deploys with celld.
import { bindings, defineConfig, defineWorker } from "cf/config";

const worker = defineWorker({
  assets: { notFoundHandling: "single-page-application" },
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
