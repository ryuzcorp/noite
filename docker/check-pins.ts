/**
 * Integrity pins for the one image: every external base image is
 * `image:tag@sha256:…`, and every downloaded tarball is checked against the
 * publisher's checksum before it is unpacked.
 *
 * Pure functions over file text, so docker/check-versions.test.ts drives them
 * with fixtures. docker/check-versions.ts reads the real files, calls
 * checkIntegrityPins, and with `--online` compares every pin with what the
 * publisher serves today (the tag's index digest, Node's signed
 * SHASUMS256.txt, npm's `dist.integrity`, GitHub's release-asset digest).
 */

export interface PinFiles {
  ci: string;
  compose: string;
  dockerfile: string;
  docs: string;
  sidecars: string;
}

export interface PinnedImage {
  /** sha256 without the `sha256:` prefix. */
  digest: string;
  /** `image:tag`, the ref the online check resolves. */
  name: string;
  /** `image:tag@sha256:…`. */
  ref: string;
}

export interface PinnedDownload {
  algo: "sha256" | "sha512";
  /** Hex digest per arch, e.g. `x64`/`arm64` or `amd64`/`arm64`. */
  digests: Record<string, string>;
  name: string;
  version: string;
}

export interface IntegrityReport {
  downloads: PinnedDownload[];
  failures: string[];
  images: PinnedImage[];
}

export type OnlineProbe =
  | { digest: string; kind: "image"; name: string; url: string }
  | {
      entries: Record<string, string>;
      kind: "shasums";
      name: string;
      url: string;
    }
  | { digest: string; kind: "npm-integrity"; name: string; url: string }
  | {
      asset: string;
      digest: string;
      kind: "github-asset";
      name: string;
      url: string;
    };

interface DownloadSpec {
  algo: "sha256" | "sha512";
  archVars: Record<string, string>;
  file: "dockerfile" | "sidecars";
  name: string;
  /** The shell fragment that selects the per-arch digest. */
  sumRef: string;
  url: string;
  versionVar: string;
}

// The downloads a build performs. Each entry is the single source of its
// version and per-arch digest; `checkIntegrityPins` proves both, that the
// digest is actually fed to `shaNsum -c`, and that the URL template below is
// the one the file fetches. `onlineProbes` turns the same data into the
// publisher lookups.
const downloadSpecs: DownloadSpec[] = [
  {
    algo: "sha256",
    archVars: { arm64: "NODE_SHA256_ARM64", x64: "NODE_SHA256_X64" },
    file: "dockerfile",
    name: "node",
    sumRef: `\${NODE_SHA256}`,
    url: `https://nodejs.org/download/release/v\${NODE_VERSION}/node-v\${NODE_VERSION}-\${NODE_PKG}.tar.xz`,
    versionVar: "NODE_VERSION",
  },
  {
    algo: "sha256",
    archVars: { arm64: "RUSTUP_SHA256_ARM64", x64: "RUSTUP_SHA256_X64" },
    file: "dockerfile",
    name: "rustup-init",
    sumRef: `\${RUSTUP_SHA256}`,
    url: `https://static.rust-lang.org/rustup/archive/\${RUSTUP_VERSION}/\${RUSTUP_TARGET}-unknown-linux-gnu/rustup-init`,
    versionVar: "RUSTUP_VERSION",
  },
  {
    algo: "sha512",
    archVars: { arm64: "ESBUILD_SHA512_ARM64", x64: "ESBUILD_SHA512_X64" },
    file: "sidecars",
    name: "esbuild",
    sumRef: `\${ESBUILD_SHA512}`,
    url: `https://registry.npmjs.org/@esbuild/\${ESBUILD_PKG}/-/\${ESBUILD_PKG}-\${ESBUILD_VERSION}.tgz`,
    versionVar: "ESBUILD_VERSION",
  },
  {
    algo: "sha256",
    archVars: { amd64: "DUCKDB_SHA256_X64", arm64: "DUCKDB_SHA256_ARM64" },
    file: "sidecars",
    name: "duckdb",
    sumRef: `\${DUCKDB_SHA256}`,
    url: `https://github.com/duckdb/duckdb/releases/download/v\${DUCKDB_VERSION}/\${DUCKDB_PKG}.tar.gz`,
    versionVar: "DUCKDB_VERSION",
  },
];

const exactlyOne = (values: string[]): string | undefined =>
  values.length === 1 ? values[0] : undefined;

const argValues = (dockerfile: string, name: string): string[] =>
  [
    ...dockerfile.matchAll(new RegExp(`^ARG ${name}=(?<value>\\S+)$`, "gmu")),
  ].map((match) => match.groups?.value ?? "");

const shellDefaultValues = (text: string, name: string): string[] =>
  [
    ...text.matchAll(
      new RegExp(`^${name}="\\$\\{${name}:-(?<value>[^}]*)\\}"`, "gmu")
    ),
  ].map((match) => match.groups?.value ?? "");

const literalValues = (text: string, name: string): string[] =>
  [...text.matchAll(new RegExp(`^${name}=(?<value>[0-9a-f]+)$`, "gmu"))].map(
    (match) => match.groups?.value ?? ""
  );

const argDefaults = (dockerfile: string): Map<string, string> => {
  const defaults = new Map<string, string>();

  for (const match of dockerfile.matchAll(
    /^ARG (?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>\S+)$/gmu
  )) {
    const name = match.groups?.name ?? "";

    if (!defaults.has(name)) {
      defaults.set(name, match.groups?.value ?? "");
    }
  }

  return defaults;
};

/** Substitute `${NAME}` from the Dockerfile's global ARG defaults. */
const resolveArgs = (
  value: string,
  args: Map<string, string>
): string | undefined => {
  const names = [
    ...value.matchAll(/\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}/gu),
  ].map((match) => match.groups?.name ?? "");

  let resolved = value;

  for (const name of names) {
    const replacement = args.get(name);

    if (replacement === undefined) {
      return undefined;
    }

    resolved = resolved.replaceAll(`\${${name}}`, replacement);
  }

  return resolved;
};

const checkImages = (dockerfile: string, failures: string[]): PinnedImage[] => {
  const images: PinnedImage[] = [];
  const seen = new Set<string>();
  const args = argDefaults(dockerfile);

  for (const match of dockerfile.matchAll(
    /^FROM\s+(?:--platform=\S+\s+)?(?<ref>\S+)(?:\s+AS\s+\S+)?\s*$/gmu
  )) {
    const ref = match.groups?.ref ?? "";

    // An earlier stage (`FROM base AS dev`): resolved inside the build.
    if (/^[A-Za-z0-9_.-]+$/u.test(ref)) {
      continue;
    }

    // The celld fork's pin has its own guard in check-versions.ts.
    if (ref === `\${CELLD_IMAGE}`) {
      continue;
    }

    const pinned =
      /^(?<repo>[^\s@]+):(?<tag>[^\s@]+)@\$\{(?<digestVar>[A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(
        ref
      );

    if (!pinned?.groups) {
      failures.push(
        `image: FROM ${ref} must be image:tag@\${DIGEST}; a tag alone drifts when the registry re-pushes it`
      );
      continue;
    }

    // SAFETY: the pinned regex's three named groups are all present when it
    // matches, and the guard above rejected a non-match.
    const { digestVar, repo, tag } = pinned.groups as {
      digestVar: string;
      repo: string;
      tag: string;
    };

    const definitions = argValues(dockerfile, digestVar);
    const digest = exactlyOne(definitions);

    if (digest === undefined || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      failures.push(
        `image: ${repo}:${tag} must pin ARG ${digestVar}=sha256:<64 hex> exactly once (found ${definitions.length})`
      );
      continue;
    }

    const name = resolveArgs(`${repo}:${tag}`, args);

    if (name === undefined) {
      failures.push(
        `image: ${repo}:${tag} references an ARG with no default (${repo}:${tag})`
      );
      continue;
    }

    const hex = digest.replace(/^sha256:/u, "");
    const fullRef = `${name}@${digest}`;

    if (!seen.has(fullRef)) {
      seen.add(fullRef);
      images.push({ digest: hex, name, ref: fullRef });
    }
  }

  return images;
};

const checkDownloads = (
  files: PinFiles,
  failures: string[]
): PinnedDownload[] => {
  const downloads: PinnedDownload[] = [];

  for (const spec of downloadSpecs) {
    const text = spec.file === "dockerfile" ? files.dockerfile : files.sidecars;

    const where =
      spec.file === "dockerfile"
        ? "docker/Dockerfile"
        : "docker/install-sidecars.sh";

    const versions =
      spec.file === "dockerfile"
        ? argValues(files.dockerfile, spec.versionVar)
        : shellDefaultValues(files.sidecars, spec.versionVar);

    const version = exactlyOne(versions);

    if (version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
      failures.push(
        `${spec.name}: ${where} must pin ${spec.versionVar} once to x.y.z (found ${versions.length}: ${versions.join(", ")})`
      );
      continue;
    }

    if (
      spec.file === "sidecars" &&
      files.dockerfile.includes(`${spec.versionVar}=`)
    ) {
      failures.push(
        `${spec.name}: docker/Dockerfile must not pin ${spec.versionVar} (single source is docker/install-sidecars.sh)`
      );
    }

    const length = spec.algo === "sha256" ? 64 : 128;
    const digests: Record<string, string> = {};
    const archPattern = new RegExp(`^[0-9a-f]{${length}}$`, "u");

    for (const arch of Object.keys(spec.archVars).toSorted((a, b) =>
      a.localeCompare(b)
    )) {
      const varName = spec.archVars[arch] ?? "";

      const values =
        spec.file === "dockerfile"
          ? argValues(files.dockerfile, varName)
          : literalValues(files.sidecars, varName);

      const digest = exactlyOne(values);

      if (digest === undefined || !archPattern.test(digest)) {
        failures.push(
          `${spec.name}: ${where} must define ${varName} once as a ${length}-digit ${spec.algo} hex digest (found ${values.length})`
        );
        continue;
      }

      if (!text.includes(`\${${varName}}`)) {
        failures.push(
          `${spec.name}: ${varName} is never used; the install must select it per arch`
        );
      }

      digests[arch] = digest;
    }

    if (!text.includes(spec.sumRef)) {
      failures.push(
        `${spec.name}: the install must verify the download with ${spec.sumRef}`
      );
    }

    if (!text.includes(`${spec.algo}sum -c -`)) {
      failures.push(
        `${spec.name}: the install must run ${spec.algo}sum -c - on the downloaded tarball`
      );
    }

    const urlCount = text.split(spec.url).length - 1;

    if (urlCount !== 1) {
      failures.push(
        `${spec.name}: ${where} must fetch ${spec.url} exactly once (found ${urlCount})`
      );
    }

    downloads.push({ algo: spec.algo, digests, name: spec.name, version });
  }

  return downloads;
};

/** A checksum next to a version is worthless if nothing verifies with it. */
const checkChecksumsAreUsed = (files: PinFiles, failures: string[]): void => {
  for (const [where, text] of [
    ["docker/Dockerfile", files.dockerfile],
    ["docker/install-sidecars.sh", files.sidecars],
  ] as const) {
    for (const match of text.matchAll(
      /^(?:ARG )?(?<name>[A-Z0-9][A-Z0-9_]*_SHA(?:256|512))=(?<value>\S+)$/gmu
    )) {
      const name = match.groups?.name ?? "";

      if (!text.includes(`\${${name}}`)) {
        failures.push(
          `${where}: ${name} is pinned but never verified (no \${${name}} in the download step)`
        );
      }
    }
  }
};

/** Downloads must land in a file first: `curl … | tar` cannot be checked. */
const checkNoUnverifiedPipes = (files: PinFiles, failures: string[]): void => {
  for (const [where, text] of [
    ["docker/Dockerfile", files.dockerfile],
    ["docker/install-sidecars.sh", files.sidecars],
  ] as const) {
    const flattened = text
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n")
      .replaceAll("\\\n", " ");

    if (
      /\bcurl\b(?:(?!&&|;)[^\n])*\|(?:(?!&&|;)[^\n])*\b(?:tar|sh|bash)\b/u.test(
        flattened
      )
    ) {
      failures.push(
        `${where}: a download is piped into tar/sh; download it, verify the checksum, then unpack`
      );
    }
  }
};

const checkRustfs = (files: PinFiles, failures: string[]): PinnedImage[] => {
  const occurrences = [
    ...files.compose.matchAll(/^[ \t]*image:.*rustfs\/rustfs:/gmu),
  ].length;

  if (occurrences !== 1) {
    failures.push(
      `rustfs: docker/compose.yaml must name the image once (found ${occurrences})`
    );
  }

  const pinned =
    /^\s*image:\s*(?<ref>\S*rustfs\/rustfs:(?<tag>[\w.-]+)@sha256:(?<digest>[0-9a-f]{64}))\s*$/mu.exec(
      files.compose
    );

  if (!pinned?.groups) {
    failures.push(
      "rustfs: docker/compose.yaml must pin the image as tag@sha256:<64 hex>"
    );

    return [];
  }

  // SAFETY: the pinned regex's three named groups are all present when it
  // matches, and the guard above rejected a non-match.
  const { digest, ref, tag } = pinned.groups as {
    digest: string;
    ref: string;
    tag: string;
  };

  const documented =
    /rustfs\/rustfs:(?<tag>[\w.-]+)/u.exec(files.docs)?.groups?.tag ?? "";

  if (!documented) {
    failures.push("rustfs: platforms.mdx must name the rustfs image tag");
  } else if (documented !== tag) {
    failures.push(
      `rustfs: docker/compose.yaml serves ${tag} but platforms.mdx documents ${documented}`
    );
  }

  const ciHits = files.ci.split(ref).length - 1;

  if (ciHits !== 1) {
    failures.push(
      `rustfs: .github/workflows/ci.yml must serve ${ref} exactly once (found ${ciHits})`
    );
  }

  return [{ digest, name: ref.replace(/@sha256:[0-9a-f]+$/u, ""), ref }];
};

export const checkIntegrityPins = (files: PinFiles): IntegrityReport => {
  const failures: string[] = [];

  const images = [
    ...checkImages(files.dockerfile, failures),
    ...checkRustfs(files, failures),
  ];

  const downloads = checkDownloads(files, failures);

  checkChecksumsAreUsed(files, failures);
  checkNoUnverifiedPipes(files, failures);

  return { downloads, failures, images };
};

/** `sha256sum`/`sha512sum` manifest text: `digest  [*]filename` per line. */
export const parseShasums = (text: string) =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = /^(?<digest>[0-9a-f]{64})\s+\*?(?<file>\S+)$/u.exec(
        line.trim()
      );

      return match?.groups?.file
        ? [[match.groups.file, match.groups.digest ?? ""]]
        : [];
    })
  );

/** npm's `dist.integrity` (`sha512-<base64>`) as hex. */
export const npmIntegrityHex = (integrity: string): string | undefined => {
  const match = /^sha512-(?<base64>[A-Za-z0-9+/]+={0,2})$/u.exec(integrity);

  if (!match?.groups?.base64) {
    return undefined;
  }

  return Buffer.from(match.groups.base64, "base64").toString("hex");
};

/** The `digest` GitHub's release API publishes for one asset, as hex. */
export const githubAssetDigest = (
  json: string,
  asset: string
): string | undefined => {
  // SAFETY: GitHub's release API response; only the `assets[].digest`/`name`
  // pair is read, and a missing asset returns undefined below.
  const parsed = JSON.parse(json) as {
    assets?: { digest?: string; name?: string }[];
  };

  const found = parsed.assets?.find((entry) => entry.name === asset);

  return found?.digest?.replace(/^sha256:/u, "");
};

// Where the publishers keep the digest each pin claims: the tag's index
// digest, the signed SHASUMS file, npm's per-version `dist.integrity`, the
// release API's asset digest. check-versions.ts `--online` fetches these.
const onlineProbesForDownload = (download: PinnedDownload): OnlineProbe[] => {
  const probes: OnlineProbe[] = [];

  const archs = Object.keys(download.digests).toSorted((a, b) =>
    a.localeCompare(b)
  );

  if (download.name === "node") {
    const entries: Record<string, string> = {};

    for (const arch of archs) {
      entries[`node-v${download.version}-linux-${arch}.tar.xz`] =
        download.digests[arch] ?? "";
    }

    probes.push({
      entries,
      kind: "shasums",
      name: "node SHASUMS256.txt",
      url: `https://nodejs.org/download/release/v${download.version}/SHASUMS256.txt`,
    });
  }

  if (download.name === "rustup-init") {
    for (const arch of archs) {
      const target = arch === "x64" ? "x86_64" : "aarch64";

      probes.push({
        entries: { "./rustup-init": download.digests[arch] ?? "" },
        kind: "shasums",
        name: `rustup-init ${target}`,
        url: `https://static.rust-lang.org/rustup/archive/${download.version}/${target}-unknown-linux-gnu/rustup-init.sha256`,
      });
    }
  }

  if (download.name === "esbuild") {
    for (const arch of archs) {
      probes.push({
        digest: download.digests[arch] ?? "",
        kind: "npm-integrity",
        name: `@esbuild/linux-${arch}`,
        url: `https://registry.npmjs.org/@esbuild/linux-${arch}/${download.version}`,
      });
    }
  }

  if (download.name === "duckdb") {
    for (const arch of archs) {
      probes.push({
        asset: `duckdb-cli-linux-${arch}.tar.gz`,
        digest: download.digests[arch] ?? "",
        kind: "github-asset",
        name: `duckdb ${arch}`,
        url: `https://api.github.com/repos/duckdb/duckdb/releases/tags/v${download.version}`,
      });
    }
  }

  return probes;
};

/** Every pin as a lookup of what the publisher serves today. */
export const onlineProbes = (
  report: IntegrityReport,
  files: PinFiles
): OnlineProbe[] => {
  const probes: OnlineProbe[] = report.images.map((image) => ({
    digest: image.digest,
    kind: "image",
    name: image.name,
    url: image.name,
  }));

  for (const download of report.downloads) {
    probes.push(...onlineProbesForDownload(download));
  }

  const args = argDefaults(files.dockerfile);

  for (const name of ["jup", "npm", "pnpm"] as const) {
    const version = args.get(`${name.toUpperCase()}_VERSION`);
    const digest = args.get(`${name.toUpperCase()}_SHA512`);

    if (version && digest) {
      probes.push({
        digest,
        kind: "npm-integrity",
        name,
        url: `https://registry.npmjs.org/${name}/${version}`,
      });
    }
  }

  return probes;
};
