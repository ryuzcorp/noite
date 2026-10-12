//! What a checkout's config makes the preview decide: the mode, the reason,
//! and every limit the panel has to show. The files here are the shapes real
//! apps hand a preview — a `cf` config, a `wrangler.jsonc`, a Vite manifest —
//! reduced to the parts the reader looks at.

import { describe, expect, test } from "bun:test";

import { previewConfig } from "./config";
import { PREVIEW_NOTES, planPreview } from "./plan";

const files = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

const WORKER_APP = {
  "cloudflare.config.ts": `// Worker config for the \`cf\` CLI
import type { InferEnv, UnwrapConfig } from "cf/config";
import { bindings, defineConfig, defineWorker, exports } from "cf/config";

import * as entrypoint from "./index.ts" with { type: "cf-worker" };

const worker = defineWorker({
  compatibilityDate: "2026-01-01",
  entrypoint,
  env: {
    COUNTER: bindings.durableObject({ exportName: "Counter", worker: "counter" }),
    DB: bindings.d1({ name: "demo" }),
    FILES: bindings.r2({ name: "uploads" }),
  },
  exports: { Counter: exports.durableObject({ storage: "sqlite" }) },
  name: "counter",
});

export type Env = InferEnv<UnwrapConfig<typeof worker>>;

export default defineConfig({ worker });
`,
  "index.ts": "export default { fetch: () => new Response('ok') };",
  "package.json": JSON.stringify({
    dependencies: { cf: "1.0.0-beta.5" },
    name: "counter",
    private: true,
    scripts: { typecheck: "tsc" },
    type: "module",
  }),
};

const VITE_APP = {
  "index.html": "<!doctype html><html><body></body></html>",
  "package.json": JSON.stringify({
    devDependencies: { "@cloudflare/vite-plugin": "^1.62.3", vite: "^8.3.2" },
    name: "vite-sample",
    private: true,
    scripts: { build: "vite build" },
  }),
  "src/index.ts": "export default { fetch: () => new Response('hi') };",
  "vite.config.ts": `import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [cloudflare()] });
`,
  "wrangler.jsonc": `{
  "name": "vite-sample",
  "main": "./src/index.ts",
  "compatibility_date": "2026-09-01",
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
  },
}`,
};

describe("planPreview", () => {
  test("a plain Worker app is served from its entry", () => {
    const plan = planPreview(files(WORKER_APP));
    expect(plan.mode).toBe("worker");
    expect(plan.notes).toEqual([PREVIEW_NOTES.localBindings]);
  });

  test("a Vite app with the Cloudflare plugin is built without it", () => {
    const plan = planPreview(files(VITE_APP));
    expect(plan.mode).toBe("vite-build");
    expect(plan.notes).toEqual([PREVIEW_NOTES.generatedViteConfig]);
  });

  test("a dev script wins when nothing native is in the way", () => {
    const plan = planPreview(
      files({
        "index.html": "<html></html>",
        "package.json": JSON.stringify({
          devDependencies: { vite: "^8" },
          name: "app",
          scripts: { dev: "vite" },
        }),
      })
    );
    expect(plan.mode).toBe("dev");
    expect(plan.notes).toEqual([]);
  });

  test("a dev script that needs workerd says so and serves the Worker instead", () => {
    const plan = planPreview(
      files({
        "package.json": JSON.stringify({
          devDependencies: { wrangler: "^4" },
          main: "src/server.ts",
          name: "app",
          scripts: { dev: "wrangler dev" },
        }),
        "src/server.ts": "export default { fetch: () => new Response('hi') };",
      })
    );
    expect(plan.mode).toBe("worker");
    expect(plan.notes).toEqual([
      "Preview cannot run wrangler (a native binary), so the dev script is not used",
    ]);
  });

  test("assets without an entry are served statically", () => {
    const plan = planPreview(
      files({
        "package.json": JSON.stringify({ name: "site", private: true }),
        "public/index.html": "<html></html>",
        "wrangler.jsonc": `{
  // a static site
  "assets": { "directory": "public", "not_found_handling": "single-page-application" },
}`,
      })
    );
    expect(plan.mode).toBe("static");
    expect(plan.notes).toEqual([]);
  });

  test("a build output directory counts as assets", () => {
    const plan = planPreview(files({ "dist/index.html": "<html></html>" }));
    expect(plan.mode).toBe("static");
    expect(plan.notes).toEqual([]);
  });

  test("a checkout with nothing runnable says exactly that", () => {
    const plan = planPreview(files({ "README.md": "# nothing" }));
    expect(plan.mode).toBe("static");
    expect(plan.notes).toEqual([PREVIEW_NOTES.nothingToRun]);
    expect(planPreview(new Map()).mode).toBe("static");
  });

  test("a declared secret is a limit, not a binding", () => {
    const plan = planPreview(
      files({
        "cloudflare.config.ts": `import { bindings, defineWorker } from "cf/config";
import * as entrypoint from "./index.ts";
const worker = defineWorker({
  entrypoint,
  env: { TOKEN: bindings.secret(), DB: bindings.d1({ name: "demo" }) },
});
export default { worker };
`,
        "index.ts": "export default { fetch: () => new Response('hi') };",
      })
    );
    expect(plan.mode).toBe("worker");
    expect(plan.notes).toEqual([
      PREVIEW_NOTES.localBindings,
      PREVIEW_NOTES.secrets,
    ]);
  });

  test("keys may arrive checkout-relative or absolute", () => {
    const absolute = new Map(
      Object.entries(WORKER_APP).map(([key, text]) => [
        `/home/project/${key}`,
        text,
      ])
    );
    const plan = planPreview(absolute);
    expect(plan.mode).toBe("worker");
    expect(plan.notes).toEqual([PREVIEW_NOTES.localBindings]);
  });
});

describe("previewConfig", () => {
  test("reads the cf config's entry, bindings and vars", () => {
    const config = previewConfig(files(WORKER_APP));
    expect(config.entry).toBe("index.ts");
    expect(
      config.bindings.map((binding) => [binding.name, binding.kind])
    ).toEqual([
      ["COUNTER", "durable-object"],
      ["DB", "d1"],
      ["FILES", "r2"],
    ]);
    // The `exportName` is the Worker's export holding the class.
    expect(config.bindings[0]?.resource).toBe("Counter");
    expect(config.bindings[1]?.resource).toBe("demo");
    expect(config.notFoundHandling).toBe("single-page-application");
  });

  test("reads a wrangler d1 migrations_dir", () => {
    const config = previewConfig(
      files({
        "wrangler.json": JSON.stringify({
          d1_databases: [
            {
              binding: "DB",
              database_name: "demo",
              migrations_dir: "migrations",
            },
          ],
          main: "index.ts",
          name: "app",
        }),
      })
    );
    expect(config.bindings).toEqual([
      {
        kind: "d1",
        migrationsDir: "migrations",
        name: "DB",
        resource: "demo",
      },
    ]);
  });

  test("reads a wrangler config with comments and trailing commas", () => {
    const config = previewConfig(
      files({
        "public/404.html": "<html>nope</html>",
        "public/index.html": "<html></html>",
        "wrangler.jsonc": `{
  // the deployed shape
  "name": "app",
  "main": "server/index.ts",
  "vars": { "GREETING": "hello", "COUNT": 2, "FLAG": true },
  "d1_databases": [{ "binding": "DB", "database_name": "demo" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "abc" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "uploads" }],
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
  "assets": { "directory": "public", "binding": "ASSETS", "not_found_handling": "404-page" },
}`,
      })
    );
    expect(config.entry).toBe("server/index.ts");
    expect(config.assets).toBe("public");
    expect(config.notFoundHandling).toBe("404-page");
    expect(config.bindings.map((binding) => binding.name)).toEqual([
      "DB",
      "CACHE",
      "FILES",
      "ROOM",
      "GREETING",
      "COUNT",
      "FLAG",
      "ASSETS",
    ]);
    expect(
      config.bindings.find((binding) => binding.name === "COUNT")?.value
    ).toBe(2);
    expect(
      config.bindings.find((binding) => binding.name === "ASSETS")?.kind
    ).toBe("assets");
  });

  test("reads a text binding's value and the cf assets handling", () => {
    const config = previewConfig(
      files({
        "cloudflare.config.ts": `import { bindings, defineWorker } from "cf/config";
import * as entrypoint from "./index.ts";
const worker = defineWorker({
  entrypoint,
  assets: { notFoundHandling: "none", htmlHandling: "none" },
  env: {
    GREETING: bindings.text("hello"),
    LIMITS: bindings.json({ retries: 3 }),
    AI: bindings.ai({ name: "model" }),
  },
});
export default { worker };
`,
        "index.ts": "export default { fetch: () => new Response('hi') };",
      })
    );
    expect(config.entry).toBe("index.ts");
    expect(config.notFoundHandling).toBe("none");
    expect(
      config.bindings.find((binding) => binding.name === "GREETING")?.value
    ).toBe("hello");
    expect(
      config.bindings.find((binding) => binding.name === "LIMITS")?.value
    ).toEqual({
      retries: 3,
    });
    expect(config.unreadable).toEqual([
      "binding AI (ai) is not available in Preview",
    ]);
  });

  test("names a Vite checkout's client half and what it cannot read", () => {
    const config = previewConfig(files(VITE_APP));
    expect(config.hasIndexHtml).toBe(true);
    expect(config.hasViteConfig).toBe(true);
    expect(config.entry).toBe("src/index.ts");
    expect(config.dev).toBeNull();
    expect(config.devDependencies["@cloudflare/vite-plugin"]).toBe("^1.62.3");
    const broken = previewConfig(
      files({
        // A named import is not the module namespace the entrypoint needs:
        // the reader says so instead of guessing a file.
        "cloudflare.config.ts": `import { defineWorker } from "cf/config";
import { server } from "./server.ts";
const worker = defineWorker({ entrypoint: server, name: "app" });
export default { worker };
`,
      })
    );
    expect(broken.entry).toBeNull();
    expect(broken.unreadable).toEqual([
      "cloudflare.config.ts: the entrypoint could not be read",
    ]);
  });
});
