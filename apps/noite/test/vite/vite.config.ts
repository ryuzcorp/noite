import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// Hidden source maps for the Errors tab (sourcemaps e2e): `hidden` emits
// `*.js.map` next to the bundles without the `sourceMappingURL` comment, so
// the runner can symbolicate stacks while browsers fetch no map file. See
// Observe → Errors in the docs.
export default defineConfig({
  build: { sourcemap: "hidden" },
  plugins: [cloudflare()],
});
