#!/usr/bin/env bun
/**
 * Pin guard for the one image (docker/Dockerfile) and its sidecars.
 *
 * - celld, Caddy, Node and jup (with its tarball digest) are pinned exactly once (an ARG default); a second pin in
 *   the same file is how a stage silently builds against another version.
 * - Every external `FROM` is `image:tag@${DIGEST}` with one `<NAME>_DIGEST`
 *   ARG, every downloaded tarball carries the publisher's per-arch
 *   sha256/sha512 next to its version, and the install verifies with it
 *   (docker/check-pins.ts owns these rules; this script reads the files and
 *   reports). Its `--online` leg, run in CI, compares each pin with the
 *   publisher's own digest.
 * - The floating lines stay covered without freezing them: every oven/bun
 *   stage must agree on one line, and the rust line must appear exactly
 *   once — a split pin fails here instead of shipping mixed toolchains.
 * - The bundled store (rustfs) must match what platforms.mdx documents and
 *   CI's rustfs service, tag and digest.
 * - Sidecar versions and checksums (esbuild, duckdb) live exactly once in
 *   docker/install-sidecars.sh; the Dockerfile only invokes the script.
 * - The access log path the image sets (CADDY_ACCESS_LOG) is the runner's own
 *   default, so the generator (which writes the Caddyfile `log` block from
 *   config) and the tailer read one file even when the ENV line is dropped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkIntegrityPins,
  hubTagUrl,
  onlineProbes,
  verifyFetchedPin,
  verifyImageDigest,
} from "./check-pins";
import type { OnlineProbe } from "./check-pins";

const root = new URL("../", import.meta.url).pathname;

const read = (rel: string): string =>
  readFileSync(path.join(root, rel), "utf-8");

const dockerfile = read("docker/Dockerfile");
const config = read("apps/runner/src/config.rs");

let failed = false;

const fail = (message: string): void => {
  console.error(message);
  failed = true;
};

/** Minimal semver compare: numeric core, then prerelease (absent wins). */
const splitVersion = (v: string) => {
  const [core, ...pre] = v.split("-");

  return {
    core: (core ?? "").split(".").map(Number),
    pre: pre.join("-"),
  };
};

const compareVersions = (a: string, b: string): number => {
  const x = splitVersion(a);
  const y = splitVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);

    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }

  if (x.pre === y.pre) {
    return 0;
  }

  if (x.pre === "") {
    return 1;
  }

  if (y.pre === "") {
    return -1;
  }

  return x.pre < y.pre ? -1 : 1;
};

for (const [name, pattern] of [
  // celld comes from the ryuzcorp/celld fork (SPEC, celld): a
  // `<version>-ryuzcorp.<level>` tag, so any other form pins zero times.
  [
    "celld",
    /ARG CELLD_VERSION=(?<version>\d+\.\d+\.\d+-ryuzcorp\.\d+)(?=\s|$)/gu,
  ],
  [
    "celld digest",
    /ARG CELLD_DIGEST=(?<version>sha256:[0-9a-f]{64})(?=\s|$)/gu,
  ],
  ["caddy", /ARG CADDY_VERSION=(?<version>\d+\.\d+\.\d+)(?=\s|$)/gu],
  ["node", /ARG NODE_VERSION=(?<version>\d+\.\d+\.\d+)(?=\s|$)/gu],
  ["jup", /ARG JUP_VERSION=(?<version>\d+\.\d+\.\d+)(?=\s|$)/gu],
  ["jup digest", /ARG JUP_SHA512=(?<version>[0-9a-f]{128})(?=\s|$)/gu],
  ["npm", /ARG NPM_VERSION=(?<version>\d+\.\d+\.\d+)(?=\s|$)/gu],
  ["npm digest", /ARG NPM_SHA512=(?<version>[0-9a-f]{128})(?=\s|$)/gu],
  ["pnpm", /ARG PNPM_VERSION=(?<version>\d+\.\d+\.\d+)(?=\s|$)/gu],
  ["pnpm digest", /ARG PNPM_SHA512=(?<version>[0-9a-f]{128})(?=\s|$)/gu],
  ["docker", /ARG DOCKER_VERSION=(?<version>\S+)/gu],
] as const) {
  const versions = [...dockerfile.matchAll(pattern)].map(
    (m) => m.groups?.version ?? ""
  );

  if (versions.length === 1) {
    console.log(`${name}: ${versions[0]}`);
  } else {
    fail(
      `${name}: docker/Dockerfile must pin exactly once (found ${versions.length}: ${versions.join(", ")})`
    );
  }
}

// The stage must pull exactly that tag from the fork's package, by
// the pinned digest: the version and digest checks above mean nothing if
// CELLD_IMAGE names another registry or the FROM line ignores it. (CI's
// `celld pin is published` step checks the digest is that tag's.)
// A Dockerfile `${NAME}` reference, spelled without tripping the
// template-in-string lint.
const arg = (name: string): string => `\${${name}}`;

const celldImage = dockerfile.match(/ARG CELLD_IMAGE=(?<image>\S+)/u)?.groups
  ?.image;

const expectedCelldImage = `ghcr.io/ryuzcorp/celld:${arg("CELLD_VERSION")}@${arg("CELLD_DIGEST")}`;

if (celldImage !== expectedCelldImage) {
  fail(
    `celld: CELLD_IMAGE must be ${expectedCelldImage} (found ${celldImage ?? "nothing"})`
  );
}

const celldFrom = [...dockerfile.matchAll(/^FROM (?<image>\S+) AS celld$/gmu)];

if (
  celldFrom.length !== 1 ||
  celldFrom[0]?.groups?.image !== arg("CELLD_IMAGE")
) {
  fail(
    `celld: docker/Dockerfile must have exactly one \`FROM ${arg("CELLD_IMAGE")} AS celld\``
  );
}

// The bundled package managers: the Dockerfile pins must name the same
// exact releases the runner resolves unpinned projects to
// (`BUNDLED_*_VERSION` in apps/runner/src/host/package_manager.rs), or an
// unpinned deploy seeds one release and asks jup for another.
const packageManager = read("apps/runner/src/host/package_manager.rs");

for (const [name, dockerPattern, runnerPattern] of [
  [
    "npm",
    /ARG NPM_VERSION=(?<version>\d+\.\d+\.\d+)/u,
    /pub const BUNDLED_NPM_VERSION: &str = "(?<version>[^"]+)"/u,
  ],
  [
    "pnpm",
    /ARG PNPM_VERSION=(?<version>\d+\.\d+\.\d+)/u,
    /pub const BUNDLED_PNPM_VERSION: &str = "(?<version>[^"]+)"/u,
  ],
] as const) {
  const dockerPin = dockerPattern.exec(dockerfile)?.groups?.version ?? "";
  const runnerPin = runnerPattern.exec(packageManager)?.groups?.version ?? "";

  if (!dockerPin || !runnerPin) {
    fail(
      `${name}: missing pin (docker/Dockerfile=${dockerPin}, runner=${runnerPin})`
    );
  } else if (dockerPin === runnerPin) {
    console.log(`${name}: bundled ${dockerPin} (image and runner agree)`);
  } else {
    fail(
      `${name}: docker/Dockerfile pins ${dockerPin} but the runner bundles ${runnerPin}`
    );
  }
}

// The edge module builds into Caddy via xcaddy: its go.mod must require
// exactly the image's CADDY_VERSION, or Go's minimum version selection
// would silently raise the Caddy that ships.
const caddyPin =
  [
    ...dockerfile.matchAll(
      /ARG CADDY_VERSION=(?<version>\d+\.\d+\.\d+)(?=\s|$)/gu
    ),
  ].map((m) => m.groups?.version ?? "")[0] ?? "";

const edgeMod = read("edge/go.mod");

const edgeCaddy =
  /github.com\/caddyserver\/caddy\/v2 v(?<version>\d+\.\d+\.\d+)/u.exec(edgeMod)
    ?.groups?.version ?? "";

if (!caddyPin || !edgeCaddy) {
  fail(
    "edge module: could not read CADDY_VERSION from the Dockerfile or the caddy require from edge/go.mod"
  );
} else if (caddyPin === edgeCaddy) {
  console.log(`edge module: caddy v${edgeCaddy} (matches image)`);
} else {
  fail(
    `edge module: edge/go.mod requires caddy v${edgeCaddy} but the image builds v${caddyPin}`
  );
}

// The Void sandbox controller bundle (SPEC, Void sandbox controller) builds
// from the pinned `void` npm version plus its `@cloudflare/sandbox` runtime:
// the package pins both exactly, the bundle's `meta.ts` reports the same
// `void` version the protocol check enforces, and the package lockfile
// freezes both for the offline image build. A drifted pin ships a controller
// the protocol check misreports.
const sandboxPackage = read("apps/void-sandbox/package.json");
const sandboxMeta = read("apps/void-sandbox/src/meta.ts");
const sandboxLock = read("apps/void-sandbox/bun.lock");

const voidPin =
  /"void":\s*"(?<version>[^"]+)"/u.exec(sandboxPackage)?.groups?.version ?? "";

const sandboxPin =
  /"@cloudflare\/sandbox":\s*"(?<version>[^"]+)"/u.exec(sandboxPackage)?.groups
    ?.version ?? "";

const metaVoid =
  /export const VOID_VERSION = "(?<version>[^"]+)"/u.exec(sandboxMeta)?.groups
    ?.version ?? "";

const exactSemver = /^\d+\.\d+\.\d+$/u;

if (!exactSemver.test(voidPin)) {
  fail(
    `sandbox controller: apps/void-sandbox/package.json must pin void exactly (found "${voidPin}")`
  );
} else if (voidPin === metaVoid && sandboxLock.includes(`void@${voidPin}`)) {
  console.log(
    `sandbox controller: void ${voidPin} (package, meta and lockfile agree)`
  );
} else if (voidPin === metaVoid) {
  fail(
    `sandbox controller: apps/void-sandbox/bun.lock does not freeze void@${voidPin}`
  );
} else {
  fail(
    `sandbox controller: package.json pins void ${voidPin} but src/meta.ts reports ${metaVoid || "nothing"}`
  );
}

if (!exactSemver.test(sandboxPin)) {
  fail(
    `sandbox controller: apps/void-sandbox/package.json must pin @cloudflare/sandbox exactly (found "${sandboxPin}")`
  );
} else if (sandboxLock.includes(`@cloudflare/sandbox@${sandboxPin}`)) {
  console.log(
    `sandbox controller: @cloudflare/sandbox ${sandboxPin} (package and lockfile agree)`
  );
} else {
  fail(
    `sandbox controller: apps/void-sandbox/bun.lock does not freeze @cloudflare/sandbox@${sandboxPin}`
  );
}

const imageLog = /CADDY_ACCESS_LOG=(?<sink>\S+)/u.exec(dockerfile)?.groups
  ?.sink;

const defaultLog =
  /"CADDY_ACCESS_LOG"\)\s*\.unwrap_or_else\(\|_\| "(?<sink>[^"]+)"/u.exec(
    config
  )?.groups?.sink;

if (!imageLog || !defaultLog) {
  fail(
    "access log: could not read CADDY_ACCESS_LOG from the Dockerfile or config.rs"
  );
} else if (imageLog === defaultLog) {
  console.log(`access log: ${imageLog}`);
} else {
  fail(
    `access log: image sets ${imageLog} but the runner defaults to ${defaultLog}`
  );
}

// The per-app build uid range lives in config.rs and is pre-created in the
// image's /etc/passwd (Node's os.userInfo() throws for a uid with no passwd
// entry). If the two drift, tenant Node tools fail on a perfectly valid uid.
const uidBase = /pub const BUILD_UID_BASE: u32 = (?<n>\d+)/u.exec(config)
  ?.groups?.n;

const uidRange = /pub const BUILD_UID_RANGE: u32 = (?<n>\d+)/u.exec(config)
  ?.groups?.n;

const uidSeq = /seq (?<lo>\d+) (?<hi>\d+)/u.exec(dockerfile)?.groups;

if (uidBase && uidRange && uidSeq) {
  const expectedHigh = Number(uidBase) + Number(uidRange) - 1;

  if (
    Number(uidSeq.lo) !== Number(uidBase) ||
    Number(uidSeq.hi) !== expectedHigh
  ) {
    fail(
      `build uid range: config.rs ${uidBase}..${expectedHigh} but the Dockerfile creates ${uidSeq.lo}..${uidSeq.hi}`
    );
  } else {
    console.log(`build uid range: ${uidBase}..${expectedHigh}`);
  }
} else {
  fail(
    "build uid range: could not read BUILD_UID_BASE/RANGE from config.rs or the seq from the Dockerfile"
  );
}

// Floating image lines: bun must agree across stages (ui-build on full
// debian, the runtime on slim), and the rust line must stay a single pin —
// neither may silently split into two versions.
const bunRefs = [
  ...dockerfile.matchAll(/oven\/bun:(?<version>[^-:\s]+)-/gu),
].map((m) => m.groups?.version ?? "");

if (bunRefs.length === 0) {
  fail("bun: no oven/bun image ref found in docker/Dockerfile");
} else if (bunRefs.every((v) => v === bunRefs[0])) {
  console.log(`bun: ${bunRefs[0]} (all stages)`);
} else {
  fail(`bun: stages disagree (${bunRefs.join(", ")}); pin one line everywhere`);
}

const rustRefs = [
  ...dockerfile.matchAll(/library\/rust:(?<version>[^-:\s]+)-bookworm/gu),
].map((m) => m.groups?.version ?? "");

if (rustRefs.length === 1) {
  console.log(`rust: ${rustRefs[0]}-bookworm`);
} else {
  fail(
    `rust: docker/Dockerfile must pin exactly once (found ${rustRefs.length}: ${rustRefs.join(", ")})`
  );
}

// The bundled store and the image's supply chain: every external FROM is
// digest-pinned, every downloaded tarball is verified against the publisher's
// checksum, and compose.yaml's rustfs is tag@digest and matches what
// platforms.mdx documents and what CI's runner tests pull.
const composeYaml = read("docker/compose.yaml");
const platformsDoc = read("apps/website/docs/self-hosting/platforms.mdx");
const sidecars = read("docker/install-sidecars.sh");
const ciWorkflow = read(".github/workflows/ci.yml");

const pinFiles = {
  ci: ciWorkflow,
  compose: composeYaml,
  dockerfile,
  docs: platformsDoc,
  sidecars,
};

const pins = checkIntegrityPins(pinFiles);

for (const failure of pins.failures) {
  fail(failure);
}

for (const image of pins.images) {
  console.log(`image: ${image.name} @ ${image.digest.slice(0, 12)}…`);
}

for (const download of pins.downloads) {
  console.log(
    `download: ${download.name} ${download.version} (${download.algo}, ${Object.keys(download.digests).join("/")})`
  );
}

// `@noitenow/cli` ships its version to npm: the release commit bumps
// packages/cli/package.json alongside the CHANGELOG section, and the tag's
// publish job refuses anything but an exact match. Between releases the
// guard below only asks for monotonicity (the CLI must never fall behind
// the latest dated section), so bumping early in a cycle stays green.
const cliVersion =
  /"version":\s*"(?<version>[^"]+)"/u.exec(read("packages/cli/package.json"))
    ?.groups?.version ?? "";

const latestRelease =
  [...read("CHANGELOG.md").matchAll(/^## \[(?<v>[^\]]+)\]/gmu)]
    .map((m) => m.groups?.v ?? "")
    .find((v) => v !== "Unreleased") ?? "";

if (!/^\d+\.\d+\.\d+(?<pre>-[0-9A-Za-z.-]+)?$/u.test(cliVersion)) {
  fail(`cli: packages/cli/package.json version is not semver (${cliVersion})`);
} else if (latestRelease === "") {
  fail("cli: CHANGELOG.md has no dated section to compare against");
} else if (compareVersions(cliVersion, latestRelease) < 0) {
  fail(
    `cli: ${cliVersion} is behind the latest CHANGELOG section [${latestRelease}] (bump packages/cli/package.json in the release commit)`
  );
} else {
  console.log(`cli: ${cliVersion} (>= [${latestRelease}])`);
}

if (!dockerfile.includes("install-sidecars.sh")) {
  fail("sidecars: docker/Dockerfile no longer invokes install-sidecars.sh");
}

// The UI image builds from its own lockfile (the Docker stage cannot use the
// workspace lock), so every direct dependency of apps/noite must resolve to
// the version the workspace tests. Drift here ships an untested UI: void
// 1.7.0, for one, stopped emitting the root `dist/wrangler.json` and turned
// the control deploy into a silent no-op.
const lockVersion = (lock: string, name: string): string | undefined =>
  new RegExp(
    `"${name.replaceAll("/", "\\/")}": \\["${name.replaceAll("/", "\\/")}@([^"]+)"`,
    "u"
  )
    .exec(lock)
    ?.at(1);

const rootLock = read("bun.lock");
const uiLock = read("apps/noite/bun.lock");

// SAFETY: package.json is the repo's own manifest; the two fields below are
// the ones this check reads (both optional).
const uiPackage = JSON.parse(read("apps/noite/package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// `void` is the UI's whole build/runtime contract: a caret range re-resolved
// 1.3.0 to 1.7.0 on a lockfile regeneration, and 1.7's build emits no root
// `dist/wrangler.json`, which silently disabled the control deploy.
const uiVoidPin =
  uiPackage.dependencies?.void ?? uiPackage.devDependencies?.void ?? "";

if (/^\d+\.\d+\.\d+$/u.test(uiVoidPin)) {
  console.log(`ui: void pinned at ${uiVoidPin}`);
} else {
  fail(
    `ui: apps/noite/package.json must pin void exactly (found "${uiVoidPin}"): a range lets a lockfile regeneration change the build layout`
  );
}

const drifted: string[] = [];

for (const name of [
  ...Object.keys(uiPackage.dependencies ?? {}),
  ...Object.keys(uiPackage.devDependencies ?? {}),
]) {
  const spec =
    uiPackage.dependencies?.[name] ?? uiPackage.devDependencies?.[name];

  // Aliased packages (`npm:...`) resolve under another name: skip them.
  if (spec?.startsWith("npm:")) {
    continue;
  }

  const workspace = lockVersion(rootLock, name);

  const image = lockVersion(uiLock, name);

  if (workspace !== image) {
    drifted.push(`${name} workspace=${workspace ?? "?"} image=${image ?? "?"}`);
  }
}

if (drifted.length === 0) {
  console.log("ui lock: apps/noite/bun.lock matches the workspace resolutions");
} else {
  fail(
    `ui lock: apps/noite/bun.lock drifts from bun.lock (regenerate it with the workspace versions): ${drifted.join(", ")}`
  );
}

/** Non-Hub registries: resolve the tag's index digest through buildx. */
const verifyImageViaDocker = (
  probe: Extract<OnlineProbe, { kind: "image" }>
): string | undefined => {
  const result = spawnSync(
    "docker",
    [
      "buildx",
      "imagetools",
      "inspect",
      probe.url,
      "--format",
      "{{json .Manifest.Digest}}",
    ],
    { encoding: "utf-8" }
  );

  const digest = (result.stdout ?? "").trim().replaceAll('"', "");

  if (result.status !== 0) {
    return `online: could not inspect ${probe.url}: ${(result.stderr ?? "").trim() || "docker failed"}`;
  }

  return verifyImageDigest(probe, digest);
};

// `--online`: compare every pin with what the publisher serves today. CI runs
// this leg; the offline checks above stay the local gate (no network, no
// docker). A version bumped without its digest fails here: SHASUMS256.txt,
// npm's `dist.integrity`, the release asset digest and the tag's index digest
// are the sources the pins claim to come from.
if (process.argv.includes("--online")) {
  const cache = new Map<string, Promise<{ error?: string; text?: string }>>();

  const fetchText = (
    url: string
  ): Promise<{ error?: string; text?: string }> => {
    const hit = cache.get(url);

    if (hit !== undefined) {
      return hit;
    }

    const headers = new Headers({ "user-agent": "noite-check-versions" });
    const token = process.env.GH_TOKEN;

    if (token && url.startsWith("https://api.github.com/")) {
      headers.set("authorization", `Bearer ${token}`);
    }

    const pending = (async () => {
      try {
        const response = await fetch(url, { headers });

        return response.ok
          ? { text: await response.text() }
          : { error: String(response.status) };
      } catch (error) {
        // A DNS/TLS/timeout failure is a red check with a readable line, not
        // an unhandled rejection with a stack trace.
        return { error: String(error) };
      }
    })();

    cache.set(url, pending);

    return pending;
  };

  const verify = async (probe: OnlineProbe): Promise<string | undefined> => {
    if (probe.kind === "image") {
      const hubUrl = hubTagUrl(probe.url);

      if (hubUrl === undefined) {
        return verifyImageViaDocker(probe);
      }

      const fetched = await fetchText(hubUrl);

      if (fetched.error !== undefined) {
        return `online: could not resolve ${probe.url}: ${fetched.error}`;
      }

      // SAFETY: Docker Hub's tag document; only `digest` is read, and a
      // missing field is reported as a mismatch below.
      const tagDoc = JSON.parse(fetched.text ?? "") as { digest?: string };

      return verifyImageDigest(probe, tagDoc.digest ?? "");
    }

    const fetched = await fetchText(probe.url);

    if (fetched.error !== undefined) {
      return `online: ${probe.url} answered ${fetched.error}`;
    }

    return verifyFetchedPin(probe, fetched.text ?? "");
  };

  const probes = onlineProbes(pins, pinFiles);
  const results = await Promise.all(probes.map((probe) => verify(probe)));

  const mismatches = results.flatMap((failure) =>
    failure === undefined ? [] : [failure]
  );

  for (const mismatch of mismatches) {
    fail(mismatch);
  }

  console.log(`online: ${probes.length} publisher pins checked`);
}

if (failed) {
  process.exit(1);
}
