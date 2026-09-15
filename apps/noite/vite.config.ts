import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { defineConfig } from "vite";

import { controlEnv, hydrateControlEnv } from "./src/lib/control-env.ts";

hydrateControlEnv();

export default defineConfig({
  plugins: [
    oxide({
      actions: {
        sameOrigin: true,
        transport: "http",
      },
      // SAFETY: controlEnv is a plain-object env bag; oxide only reads known keys off it, so casting to its `never`-indexed env type is safe (the bag holds only strings + durable bindings written before vite boot).
      env: controlEnv as never,
      imports: [],
      middleware: [
        "./src/middleware/durable.ts",
        "./src/middleware/host.ts",
        "./src/middleware/db.ts",
        "./src/middleware/api.ts",
        "@ilha/router/ssr",
      ],
      preset: "fetch",
    }),
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
  },
});
