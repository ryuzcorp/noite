import { readFile } from "node:fs/promises";
import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { withOxide } from "oxidejs/wrangler";
import type { DurableWranglerConfig } from "oxidejs/wrangler";
import { defineConfig } from "vite";
import type { Plugin, ViteDevServer } from "vite";

import { controlEnv, hydrateControlEnv } from "./src/lib/control-env.ts";

hydrateControlEnv();

/**
 * Dev-only SPA fallback (oxide forces appType custom, so Vite has none,
 * and the worker handler claims every non-root path without an ASSETS
 * binding in dev). Serves the transformed shell directly for document
 * navigations without a file extension. API/action/frame/stream paths and
 * real files pass through untouched. Deploy snapshots carry the same
 * fallback via not_found_handling.
 */
const spaDevFallback = (): Plugin => ({
  apply: "serve",
  configureServer(server: ViteDevServer) {
    // oxlint-disable-next-line no-async-endpoint-handlers -- dev-only middleware; rejections are forwarded, every await sits in try/catch ending in return next().
    server.middlewares.use(async (req, res, next) => {
      const raw = req.url ?? "/";
      const pathname = raw.split("?", 1)[0] ?? "/";
      const accept = req.headers.accept ?? "";
      const dest = req.headers["sec-fetch-dest"];
      const isNav =
        req.method === "GET" &&
        (dest === "document" || accept.includes("text/html"));
      const isApi =
        pathname.startsWith("/__oxide") ||
        pathname.startsWith("/__ilha") ||
        pathname.startsWith("/api") ||
        pathname.startsWith("/internal") ||
        pathname.startsWith("/storage") ||
        pathname.startsWith("/cdn-cgi") ||
        pathname === "/health" ||
        pathname === "/webhook";
      const last = pathname.split("/").at(-1) ?? "";
      if (!isNav || isApi || last.includes(".")) {
        return next();
      }
      try {
        const html = await readFile(
          path.join(server.config.root, "index.html"),
          "utf-8"
        );
        const out = await server.transformIndexHtml(raw, html);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(out);
      } catch {
        return next();
      }
    });
  },
  name: "noite-spa-dev-fallback",
});

export default defineConfig({
  plugins: [
    spaDevFallback(),
    oxide({
      actions: {
        sameOrigin: true,
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
