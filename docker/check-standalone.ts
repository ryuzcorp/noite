#!/usr/bin/env bun
// Standalone-compose drift guard. `docker/compose.standalone.yaml` is a
// hand-maintained mirror of `docker/compose.yaml` — pull-only images, no
// `build:` blocks — for cloud VMs and Compose stores (Arcane, Portainer, …).
// Nothing structural stops it from falling behind when a service gains an env
// var or a volume, and a store user cannot patch that up. CI renders both files
// and passes them here:
//
//   BASE_DOMAIN=localhost docker compose -f docker/compose.yaml config --format json > base.json
//   docker compose -f docker/compose.standalone.yaml config --format json > standalone.json
//   bun docker/check-standalone.ts base.json standalone.json
//
// Fails when a service, volume or env key of the base install is missing from
// the standalone one, when the standalone builds instead of pulling, or when a
// service there still points at a locally-built image.
import { readFileSync } from "node:fs";

/** Values Compose emits for an env var: a scalar, or null for a pass-through. */
type EnvValue = string | number | boolean | null;

type EnvMap = Record<string, EnvValue>;

interface Service {
  /** Present (any object) ⇔ the service builds from a Dockerfile. */
  build?: EnvMap;
  environment?: EnvMap | string[];
  image?: string;
}

interface RenderedCompose {
  services?: Record<string, Service>;
  volumes?: EnvMap;
}

const envKeys = (service: Service): string[] => {
  const environment = service.environment ?? {};
  if (Array.isArray(environment)) {
    return environment.map((entry) => entry.split("=")[0] ?? "");
  }
  return Object.keys(environment);
};

const load = (path: string, label: string): RenderedCompose => {
  try {
    // SAFETY: `docker compose config --format json` emits exactly this
    // Compose schema. Every field read below is optional and treated as
    // absent when a shape differs, so a schema change degrades to "nothing to
    // compare" rather than to a wrong verdict.
    return JSON.parse(readFileSync(path, "utf-8")) as RenderedCompose;
  } catch (error) {
    console.error(`${label} (${path}) is not readable JSON: ${String(error)}`);
    return process.exit(2);
  }
};

const [basePath, standalonePath] = process.argv.slice(2);
if (basePath === undefined || standalonePath === undefined) {
  console.error(
    "usage: bun docker/check-standalone.ts <base.json> <standalone.json>"
  );
  process.exit(2);
}

const base = load(basePath, "base install config");
const standalone = load(standalonePath, "standalone config");
const standaloneServices = standalone.services ?? {};
const problems: string[] = [];

for (const [name, service] of Object.entries(base.services ?? {})) {
  const mirrored = standaloneServices[name];
  if (mirrored === undefined) {
    problems.push(`service "${name}" is missing`);
    continue;
  }
  if (mirrored.build !== undefined) {
    problems.push(
      `service "${name}" builds instead of pulling (drop the build: block)`
    );
  }
  if (mirrored.image?.endsWith(":local") === true) {
    problems.push(
      `service "${name}" points at a locally-built image (${mirrored.image})`
    );
  }
  const have = new Set(envKeys(mirrored));
  for (const key of envKeys(service)) {
    if (!have.has(key)) {
      problems.push(`service "${name}" is missing ${key}`);
    }
  }
}

for (const name of Object.keys(base.volumes ?? {})) {
  if (Object.hasOwn(standalone.volumes ?? {}, name) === false) {
    problems.push(`volume "${name}" is missing`);
  }
}

if (problems.length > 0) {
  console.error(
    "docker/compose.standalone.yaml is behind docker/compose.yaml:"
  );
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
console.log(
  `standalone: ${Object.keys(standaloneServices).length} services, ${Object.keys(standalone.volumes ?? {}).length} volumes mirror the base install`
);
