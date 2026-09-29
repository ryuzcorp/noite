// Convert a tenant's `cloudflare.config.ts` (the `cf` CLI config) into the
// `wrangler.json` celld deploys. Embedded in the runner (`deploy.rs`) and run
// as `node --input-type=module -e <this> <config>` inside the build sandbox,
// with the worktree as cwd: `@cloudflare/config` resolves from the tenant's
// own node_modules (a dependency of `cf`), so the schema matches the `cf`
// version the app was written against. Node, not Bun: config loading needs
// Node's module hooks for `with { type: "cf-worker" }` imports.
import { writeFileSync } from "node:fs";
import path from "node:path";

const [configFile] = process.argv.slice(1);

// Expected failures print one line into the deploy log, not a stack trace.
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let cfConfig;
try {
  cfConfig = await import("@cloudflare/config");
} catch {
  fail(
    `${configFile} needs \`cf\` in package.json dependencies (it provides @cloudflare/config)`
  );
}

const { result } = await cfConfig.loadAndParseConfig(configFile, {
  isPreview: false,
  mode: "production",
});
if (!result.success) {
  fail(`${configFile} is invalid:\n${result.error.message}`);
}
const wrangler = cfConfig.convertToWranglerConfig(result.data);

// The loader anchors `cf-worker` entrypoints as absolute paths; celld
// bundles from the config's directory.
if (wrangler.main && path.isAbsolute(wrangler.main)) {
  wrangler.main = path.relative(process.cwd(), wrangler.main);
}

// celld 0.6 rejects the new `exports` key: created Durable Objects become one
// classic migration. Deleting, renaming and transferring classes have no
// celld equivalent.
if (wrangler.exports) {
  const sqlite = [];
  const kv = [];
  for (const [name, value] of Object.entries(wrangler.exports)) {
    const created =
      value.type === "durable-object" && value.state === undefined;
    if (!created) {
      const kind = value.state ? `${value.type} (${value.state})` : value.type;
      fail(`exports.${name}: ${kind} is not supported on Noite`);
    }
    (value.storage === "sqlite" ? sqlite : kv).push(name);
  }
  delete wrangler.exports;
  const migration = { tag: "v1" };
  if (sqlite.length > 0) {
    migration.new_sqlite_classes = sqlite;
  }
  if (kv.length > 0) {
    migration.new_classes = kv;
  }
  wrangler.migrations = [migration];
}

// A binding to this Worker's own class needs no script_name.
for (const binding of wrangler.durable_objects?.bindings ?? []) {
  if (binding.script_name === wrangler.name) {
    delete binding.script_name;
  }
}

// Noite keys D1 databases by id; `bindings.d1({ name })` alone is enough.
for (const db of wrangler.d1_databases ?? []) {
  db.database_id ??= db.database_name;
}

// `bindings.secret()` declares a required secret; Noite injects app env vars
// (Settings → Environment) instead, and celld rejects the key.
delete wrangler.secrets;

writeFileSync("wrangler.json", `${JSON.stringify(wrangler, null, 2)}\n`);
console.log(`${configFile} → wrangler.json`);
