import { cloudflare } from "@cloudflare/vite-plugin";
import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { withOxide } from "oxidejs/wrangler";
import type { DurableWranglerConfig } from "oxidejs/wrangler";
import { defineConfig } from "vite";

import { controlEnv, hydrateControlEnv } from "./src/lib/control-env.ts";

hydrateControlEnv();

export default defineConfig({
  plugins: [
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
          // SAFETY: withOxide only types the durable slice of the Cloudflare config; assets is the platform's own key and passes through to both snapshots untouched.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- bridging withOxide's narrow durable type to the platform assets key.
          const cfg = c as unknown as {
            assets?: { directory?: string; not_found_handling?: string };
          };
          cfg.assets = {
            ...cfg.assets,
            not_found_handling: "single-page-application",
          };
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
