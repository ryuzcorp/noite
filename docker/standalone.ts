#!/usr/bin/env bun
// Standalone prod compose: everything needed to run Noite on any cloud VM
// from ONE file — no repo clone. Reads docker/compose.yaml and emits a
// self-contained file (GHCR images, named volumes only):
//   bun docker/standalone.ts [--tag ghcr.io/ryuzcorp/noite:latest] [--caddy-tag ghcr.io/ryuzcorp/noite-caddy:latest]
// Then: BASE_DOMAIN=noite.now BETTER_AUTH_SECRET=... RUNNER_TOKEN=... \
//   RUSTFS_ACCESS_KEY=... RUSTFS_SECRET_KEY=... docker compose -f compose.standalone.yaml up -d
// NOTE: this covers infra (rustfs + celld node + edge). The control worker
// bundle (apps/noite/dist) still reaches the fleet via `celld deploy` —
// see the release process; a fresh bucket serves nothing until deployed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const arg = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ??
  fallback;
const tag = arg("--tag", "ghcr.io/ryuzcorp/noite:latest");
const caddyTag = arg("--caddy-tag", "ghcr.io/ryuzcorp/noite-caddy:latest");
const outFile = path.resolve(
  root,
  arg("--out", "docker/compose.standalone.yaml")
);

const compose = readFileSync(path.join(root, "docker/compose.yaml"), "utf-8");
const out: string[] = [];
const lines = compose.split("\n");
// Strip the base file's header comments (make/dev instructions, repo paths)
// — the generated header below replaces them; leftovers would instruct a
// cloner-less user to run repo commands.
let headerDone = false;
let skipBuildBlock = false;
for (const line of lines) {
  if (!headerDone) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    headerDone = true;
  }
  // Drop local-build blocks (standalone always pulls).
  if (/^ {4}build:\s*$/u.test(line)) {
    skipBuildBlock = true;
    continue;
  }
  if (skipBuildBlock) {
    if (/^ {6}(?<key>context|dockerfile):/u.test(line)) {
      continue;
    }
    skipBuildBlock = false;
  }
  // Drop the Caddyfile bind-mount (baked into the edge image below).
  if (line === "      - ./Caddyfile.static:/etc/caddy/Caddyfile:ro,z") {
    continue;
  }
  out.push(line);
}

let text = out.join("\n");
const buildNote = `    # Built from the repo root (the Dockerfile COPYs apps/runner/…).
    # \`make up\` passes --build, so a source change always ships — no
    # separate build step to forget. Coolify: set NOITE_RUNNER_IMAGE to
    # the GHCR release tag to pull instead of building.
`;
if (!text.includes(buildNote)) {
  throw new Error("control build comment moved — update standalone.ts");
}
text = text.replace(
  buildNote,
  "    # Pinned at generation time (--tag); re-run the generator to change it.\n"
);
// Pin both release images (drop the local-build defaults).
text = text.replaceAll(
  // oxlint-disable-next-line eslint/no-template-curly-in-string -- matching literal compose source text, not interpolating.
  "image: ${NOITE_RUNNER_IMAGE:-noite-runner:local}",
  `image: ${tag}`
);
text = text.replace("image: noite-caddy:local", `image: ${caddyTag}`);
// Drop the build-cache volume (nothing builds here).
text = text.replaceAll(/^ {2}bun-cache:\n/gmu, "");
// The container cell needs an engine: mount the host socket where
// DOCKER_HOST points. Standalone-only (cloud Docker hosts expose
// /var/run/docker.sock; override DOCKER_SOCK for podman/odd layouts).
// Kept OUT of the base file: a missing source breaks `make up` on
// rootless podman, which has no socket at the Docker path.
const staleCaddyComment = `      # Static edge: single wildcard site + on-demand TLS (ask via the
      # control worker) → reverse_proxy control:8090 for everything. See
      # docker/Caddyfile.static. \`:z\` relabels for container reads on
      # SELinux-enforcing hosts (Fedora); ignored elsewhere.
`;
if (!text.includes(staleCaddyComment)) {
  throw new Error("caddy volumes comment moved — update standalone.ts");
}
text = text.replace(
  staleCaddyComment,
  `      # Static edge baked into the image; this volume persists certs only.
`
);
// The container cell needs an engine: mount the host socket where
// DOCKER_HOST points. Standalone-only (cloud Docker hosts expose
// /var/run/docker.sock; override DOCKER_SOCK for podman/odd layouts).
// Kept OUT of the base file: a missing source breaks `make up` on
// rootless podman, which has no socket at the Docker path.
const sockAnchor = `      PORT_BASE: "8100"\n`;
const sockBlock = `      PORT_BASE: "8100"
    volumes:
      - "\${DOCKER_SOCK:-/var/run/docker.sock}:/run/podman/podman.sock:ro"
`;
if (!text.includes(sockAnchor)) {
  throw new Error("control env block moved — update standalone.ts");
}
text = text.replace(sockAnchor, sockBlock);

const header = `# Noite production stack — STANDALONE (generated, do not edit).
# Source: docker/compose.yaml via \`bun docker/standalone.ts --tag ${tag}\`.
# Run anywhere with compose + four env vars:
#   BASE_DOMAIN=noite.now BETTER_AUTH_SECRET=<random> RUNNER_TOKEN=<random> \\
#   RUSTFS_ACCESS_KEY=<key> RUSTFS_SECRET_KEY=<secret> \\
#   docker compose -f compose.standalone.yaml up -d
# Images: ${tag} + ${caddyTag}. Worker bundle (apps/noite/dist) is NOT in
# this file — deploy it to the fleet with \`celld deploy\` after boot.
`;
writeFileSync(outFile, header + text);
console.log(`standalone compose written to ${outFile}`);
