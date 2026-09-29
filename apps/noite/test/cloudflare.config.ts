// Worker config for the `cf` CLI (https://github.com/cloudflare/cf). Noite
// converts it to the wrangler.json celld deploys (runner, host/deploy.rs).
import type { InferEnv, UnwrapConfig } from "cf/config";
import { bindings, defineConfig, defineWorker, exports } from "cf/config";

import * as entrypoint from "./index.ts" with { type: "cf-worker" };

const worker = defineWorker({
  compatibilityDate: "2026-01-01",
  entrypoint,
  env: {
    COUNTER: bindings.durableObject({
      exportName: "Counter",
      worker: "counter",
    }),
    DB: bindings.d1({ name: "demo" }),
    FILES: bindings.r2({ name: "uploads" }),
  },
  exports: {
    Counter: exports.durableObject({ storage: "sqlite" }),
  },
  name: "counter",
});

/** The Worker's `env`, inferred from the bindings above. */
export type Env = InferEnv<UnwrapConfig<typeof worker>>;

export default defineConfig({ worker });
