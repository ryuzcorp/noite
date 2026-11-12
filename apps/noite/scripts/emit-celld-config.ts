/**
 * Write the deploy-root `dist/wrangler.json` celld deploys, derived from
 * Void's own `dist/ssr/wrangler.json` (never handwritten): `main` rewrites
 * to deploy-root-relative `ssr/…`, the asset directory to `client`, and
 * `vars` to `{}` (the runner patches the real vars at deploy time).
 *
 * A build script, not a Vite plugin: a `closeBundle` hook only runs after
 * the bundle that owns it closes, so the hook that lifts this manifest raced
 * Void's own emit and, on the first layout change, wrote nothing — the image
 * then booted undeployable (`no wrangler config under /opt/noite/control/
 * dist`). `bun run build` runs this after `vite build` has returned, so the
 * manifest exists before anything packages the bundle, and a missing SSR
 * manifest fails the build instead of shipping a control plane that cannot
 * boot.
 *
 * Local-only `.dev.vars` files are removed from `dist/` and `dist/ssr/` so
 * they never ship inside the bundle (the Dockerfile strips them too), and
 * Void's Cloudflare-only `dist/client/.assetsignore` is removed: `celld
 * deploy` refuses it outright, and its two entries need no replacement —
 * `wrangler.json` is celld's config surface (never an asset) and `.dev.vars`
 * is removed just above.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RUN_WORKER_FIRST } from "../void.config.ts";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const dist = path.join(APP_ROOT, "dist");

/** Top-level keys `celld deploy` accepts. Mirrors `CELLD_KEYS` in
 * `apps/runner/src/host/build_output.rs` — an unknown key fails the deploy,
 * so anything Void emits outside this set is dropped, never passed through. */
const CELLD_KEYS = [
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "queues",
  "workflows",
  "r2_buckets",
  "containers",
] as const;

/** One D1 binding entry in Void's generated `dist/ssr/wrangler.json`. */
interface D1DatabaseEntry {
  binding?: string;
  database_name?: string;
  migrations_dir?: string;
}

for (const dir of [dist, path.join(dist, "ssr")]) {
  let entries: string[] = [];

  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }

  for (const entry of entries) {
    if (entry === ".dev.vars" || entry.startsWith(".dev.vars.")) {
      rmSync(path.join(dir, entry), { force: true });
    }
  }
}

rmSync(path.join(dist, "client", ".assetsignore"), { force: true });

let emitted: string;

try {
  emitted = readFileSync(path.join(dist, "ssr", "wrangler.json"), "utf-8");
} catch {
  throw new Error(
    `void wrote no ssr/wrangler.json under ${dist}; refusing to ship an undeployable control bundle`
  );
}

/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- the build boundary: Void's generated wrangler.json is JSON whose keys are celld's config surface, so its shape is an open dictionary and this is the one place that takes it apart. Every field is checked here before it is read, and only CELLD_KEYS allowlisted entries leave this section. */
const ssr = JSON.parse(emitted) as Record<string, unknown>;

const ssrAssets =
  typeof ssr["assets"] === "object" && ssr["assets"] !== null
    ? (ssr["assets"] as Record<string, unknown>)
    : {};

const ssrMain =
  typeof ssr["main"] === "string" && ssr["main"] ? ssr["main"] : "index.js";

const config: Record<string, unknown> = {};

for (const key of CELLD_KEYS) {
  if (key in ssr) {
    config[key] = ssr[key];
  }
}

config["main"] = `ssr/${ssrMain}`;
// The same rule list as `void.config.ts` (`RUN_WORKER_FIRST`): celld serves
// `/assets/*` from its own resolver — with the `public/_headers` cache policy
// — instead of invoking the Worker, where Void's pages fallback would fetch
// them inside the app (and its 15 s action bound). Void's own
// `dist/ssr/wrangler.json` is rewritten to `["/**"]` by its asset-bypass
// normalizer, so this file is the only place the deployed rule survives.

config["assets"] = {
  ...ssrAssets,
  directory: "client",
  run_worker_first: [...RUN_WORKER_FIRST],
};

// D1 is keyed by name: drop Void's default `migrations_dir` (it points at a
// directory that does not exist; schema migrates at runtime via `ensureDb`,
// never through wrangler migrations).
if (Array.isArray(config["d1_databases"])) {
  for (const entry of config["d1_databases"]) {
    if (typeof entry === "object" && entry !== null) {
      // SAFETY: d1_databases entries are binding objects; only the optional migrations_dir is removed.
      delete (entry as Partial<D1DatabaseEntry>)["migrations_dir"];
    }
  }
}

/* oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */

config["vars"] = {};

writeFileSync(
  path.join(dist, "wrangler.json"),
  `${JSON.stringify(config, null, 2)}\n`
);
