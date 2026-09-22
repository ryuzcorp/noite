import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Inject `containers` into the celld deploy snapshot (G3/G4 workaround).
 *
 * Two problems, one script:
 * - G3: wrangler (hence `vite dev`) rejects image paths escaping the
 *   project dir, so the entry cannot live in wrangler.jsonc without
 *   crash-looping control in dev. It lives in `containers.jsonc` with a
 *   repo-root-relative image; this resolves it to an absolute path (whose
 *   directory becomes the build context — the repo root, so
 *   `COPY apps/runner/…` works).
 * - G4: oxide 0.5.4 `toCelldWrangler` strips `containers` (not in
 *   CELLD_WRANGLER_KEYS), so `dist/wrangler.json` loses the entry. This
 *   copies it over keeping only the keys celld accepts
 *   (class_name/image/name/instance_type/max_instances/runtime) — any other
 *   key stops the deployment.
 *
 * Runs as part of `bun run build`; no-op when the snapshot is missing
 * (e.g. `celld dev` reading wrangler.jsonc raw).
 */
import * as Schema from "effect/Schema";

const SourceContainer = Schema.Struct({
  class_name: Schema.String,
  image: Schema.String,
  instance_type: Schema.optional(Schema.String),
  max_instances: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
});

const SourceFile = Schema.Struct({
  containers: Schema.Array(SourceContainer),
});

const CelldSnapshot = Schema.Record(Schema.String, Schema.Unknown);

const stripJsonComments = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    // The repo formatter enforces trailing commas; strict JSON.parse
    // rejects them, so drop comma-before-close (values never contain one).
    .replaceAll(/,(?<close>\s*[}\]])/gu, "$<close>");

const appDir = new URL("../", import.meta.url).pathname;
const dist = path.join(appDir, "dist");
const sourceFile = path.join(appDir, "containers.jsonc");
const celldSnapshot = path.join(dist, "wrangler.json");

if (!existsSync(celldSnapshot)) {
  process.exit(0);
}

const source = Schema.decodeUnknownSync(SourceFile)(
  JSON.parse(stripJsonComments(readFileSync(sourceFile, "utf-8")))
);

// Repo root = two levels above apps/noite; absolute image keeps `celld
// deploy dist` working regardless of the invoking cwd.
const repoRoot = path.resolve(appDir, "..", "..");
const containers = source.containers.map((entry) => ({
  ...entry,
  image: path.resolve(repoRoot, entry.image),
}));
const celld = Schema.decodeUnknownSync(CelldSnapshot)(
  JSON.parse(readFileSync(celldSnapshot, "utf-8"))
);
const snapshot = { ...celld, containers };
writeFileSync(celldSnapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `injected ${containers.length} containers entry into dist/wrangler.json`
);
