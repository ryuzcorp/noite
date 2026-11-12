import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkIntegrityPins,
  githubAssetDigest,
  npmIntegrityHex,
  onlineProbes,
  parseShasums,
  verifyFetchedPin,
  verifyImageDigest,
} from "./check-pins";
import type { PinFiles } from "./check-pins";

const root = new URL("../", import.meta.url).pathname;

const readRepoFile = (rel: string): string =>
  readFileSync(path.join(root, rel), "utf-8");

// The real files, so a broken pin fails here as well as in check-versions.ts.
const repoFiles = (): PinFiles => ({
  ci: readRepoFile(".github/workflows/ci.yml"),
  compose: readRepoFile("docker/compose.yaml"),
  dockerfile: readRepoFile("docker/Dockerfile"),
  docs: readRepoFile("apps/website/docs/self-hosting/platforms.mdx"),
  sidecars: readRepoFile("docker/install-sidecars.sh"),
});

/** The current Node pin, so the bump test survives ordinary version bumps. */
const nodeVersion = (dockerfile: string): string =>
  /ARG NODE_VERSION=(?<version>\S+)/u.exec(dockerfile)?.groups?.version ?? "";

describe("checkIntegrityPins", () => {
  test("the repository pins pass", () => {
    expect(checkIntegrityPins(repoFiles()).failures).toEqual([]);
  });

  test("every external FROM is digest-pinned", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      dockerfile: files.dockerfile.replace(
        `@\${NODE_DIGEST} AS node`,
        " AS node"
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        `FROM docker.io/library/node:\${NODE_VERSION}-slim must be image:tag@\${DIGEST}`
      )
    );
  });

  test("a digest ARG must be one 64-hex sha256", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      dockerfile: files.dockerfile.replace(
        /ARG NODE_DIGEST=sha256:[0-9a-f]{64}/u,
        "ARG NODE_DIGEST=sha256:not-a-digest"
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        "must pin ARG NODE_DIGEST=sha256:<64 hex> exactly once"
      )
    );
  });

  test("each arch's checksum is required: dropping arm64 fails", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      dockerfile: files.dockerfile.replace(/^ARG NODE_SHA256_ARM64=.*$/mu, ""),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining("NODE_SHA256_ARM64")
    );
  });

  test("a version bump alone leaves the stale checksum in the online path", () => {
    const files = repoFiles();
    const pinnedVersion = nodeVersion(files.dockerfile);

    const bumped = {
      ...files,
      dockerfile: files.dockerfile.replace(
        `ARG NODE_VERSION=${pinnedVersion}`,
        "ARG NODE_VERSION=9.9.9"
      ),
    };

    // The offline structure is intact — the version and its checksums still
    // sit together — but the probe now asks the publisher about v9.9.9 and
    // compares it with the old digest, which is what CI's online leg rejects.
    const report = checkIntegrityPins(bumped);

    expect(report.failures).toEqual([]);

    const probe = onlineProbes(report, bumped).find(
      (entry) =>
        entry.kind === "shasums" && entry.name === "node SHASUMS256.txt"
    );

    expect(probe?.url).toBe(
      "https://nodejs.org/download/release/v9.9.9/SHASUMS256.txt"
    );

    if (probe?.kind === "shasums") {
      expect(probe.entries["node-v9.9.9-linux-x64.tar.xz"]).toBe(
        report.downloads.find((download) => download.name === "node")?.digests
          .x64
      );
    }
  });

  test("a checksum that no download verifies with fails", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      sidecars: files.sidecars.replace(
        `echo "\${DUCKDB_SHA256}  /tmp/duckdb.tar.gz" | sha256sum -c -`,
        'echo "unchecked"'
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        `duckdb: the install must verify the download with \${DUCKDB_SHA256}`
      )
    );
  });

  test("a checksum defined but never referenced fails", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      sidecars: `${files.sidecars}\nBOGUS_SHA256=${"a".repeat(64)}\n`,
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        "docker/install-sidecars.sh: BOGUS_SHA256 is pinned but never verified"
      )
    );
  });

  test("piping a download into tar fails, even across a continuation", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      sidecars: files.sidecars.replace(
        `curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 -o /tmp/esbuild.tgz "https://registry.npmjs.org/@esbuild/\${ESBUILD_PKG}/-/\${ESBUILD_PKG}-\${ESBUILD_VERSION}.tgz"`,
        `curl -fsSL "https://registry.npmjs.org/@esbuild/\${ESBUILD_PKG}/-/\${ESBUILD_PKG}-\${ESBUILD_VERSION}.tgz" \\\n    | tar -xz -C /tmp`
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining("a download is piped into tar/sh")
    );
  });

  test("compose's rustfs image must carry a digest", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      compose: files.compose.replace(
        /(?<ref>image: \S*rustfs\/rustfs:[^\s@]+)@sha256:[0-9a-f]{64}/u,
        "$<ref>"
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        "docker/compose.yaml must pin the image as tag@sha256:<64 hex>"
      )
    );
  });

  test("CI's rustfs service must match compose", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      ci: files.ci.replace(
        /image: \S*rustfs\/rustfs:[\w.-]+@sha256:[0-9a-f]{64}/u,
        "image: docker.io/rustfs/rustfs:0.0.1"
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        ".github/workflows/ci.yml must serve docker.io/rustfs/rustfs:"
      )
    );
  });

  test("platforms.mdx must document the compose tag", () => {
    const files = repoFiles();

    const documented = /\| `rustfs` [^|]*\| `rustfs\/rustfs:[\w.-]+`/u.exec(
      files.docs
    )?.[0];

    if (documented === undefined) {
      throw new Error("platforms.mdx no longer documents the rustfs image");
    }

    const report = checkIntegrityPins({
      ...files,
      docs: files.docs.replace(
        documented,
        "| `rustfs` | `rustfs/rustfs:0.0.1` |"
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining("but platforms.mdx documents 0.0.1")
    );
  });

  test("the Caddy builder's digest is checked too (the line is easy to miss)", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      dockerfile: files.dockerfile.replace(`@\${CADDY_DIGEST}`, ""),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        `FROM docker.io/library/caddy:\${CADDY_VERSION}-builder must be image:tag@\${DIGEST}`
      )
    );
  });

  test("an indented or lowercase FROM is still parsed and checked", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      dockerfile: files.dockerfile.replace(
        `FROM docker.io/library/node:\${NODE_VERSION}-slim@\${NODE_DIGEST} AS node`,
        `  from docker.io/library/node:\${NODE_VERSION}-slim AS node`
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        `FROM docker.io/library/node:\${NODE_VERSION}-slim must be image:tag@\${DIGEST}`
      )
    );
  });

  test("a bare external image is not mistaken for an earlier stage", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      dockerfile: files.dockerfile.replace(
        "FROM docker.io/library/rust:",
        "FROM alpine\nFROM docker.io/library/rust:"
      ),
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(`FROM alpine must be image:tag@\${DIGEST}`)
    );
  });

  test("a newly added archive download without a checksum line fails", () => {
    const files = repoFiles();

    const report = checkIntegrityPins({
      ...files,
      sidecars: `${files.sidecars}\ncurl -fsSL -o /tmp/extra.tgz "https://example.com/extra.tgz"\n`,
    });

    expect(report.failures).toContainEqual(
      expect.stringContaining(
        "/tmp/extra.tgz is downloaded but no checksum line verifies it"
      )
    );
  });
});

describe("onlineProbes", () => {
  test("the repository's pins probe every publisher source", () => {
    const files = repoFiles();
    const probes = onlineProbes(checkIntegrityPins(files), files);
    const kinds = probes.map((probe) => probe.kind);

    expect(kinds).toContain("image");
    expect(kinds).toContain("shasums");
    expect(kinds).toContain("npm-integrity");
    expect(kinds).toContain("github-asset");

    // Both arch assets of each multi-arch download are probed.
    const assets = probes
      .filter((probe) => probe.kind === "github-asset")
      .map((probe) => probe.asset)
      .toSorted();

    expect(assets).toEqual([
      "duckdb-cli-linux-amd64.tar.gz",
      "duckdb-cli-linux-arm64.tar.gz",
    ]);

    // A shared base image is resolved once, not once per stage.
    const slim = probes.filter(
      (probe) => probe.kind === "image" && probe.url.endsWith(":1.4-slim")
    );

    expect(slim).toHaveLength(1);

    // Every digest-pinned FROM reaches the online leg, the builder included.
    const caddyVersion = /ARG CADDY_VERSION=(?<version>\S+)/u.exec(
      files.dockerfile
    )?.groups?.version;

    const names = probes
      .filter((probe) => probe.kind === "image")
      .map((probe) => probe.name);

    expect(names).toContain(`docker.io/library/caddy:${caddyVersion}-builder`);
  });

  test("jup, npm and pnpm are checked against their registry integrity", () => {
    const files = repoFiles();
    const probes = onlineProbes(checkIntegrityPins(files), files);

    const names = probes
      .filter((probe) => probe.kind === "npm-integrity")
      .map((probe) => probe.name);

    expect(names).toEqual(
      expect.arrayContaining(["jup", "npm", "pnpm", "@esbuild/linux-x64"])
    );
  });
});

describe("publisher parsers", () => {
  test("parseShasums reads sha256sum manifests, `*binary` included", () => {
    const x64 =
      "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb";

    const arm64 =
      "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c";

    const manifest = [
      `${x64}  node-v24.22.3-linux-x64.tar.xz`,
      `${arm64} *node-v24.22.3-linux-arm64.tar.xz`,
      "not a checksum line",
      "",
    ].join("\n");

    expect(parseShasums(manifest)).toEqual({
      "node-v24.22.3-linux-arm64.tar.xz": arm64,
      "node-v24.22.3-linux-x64.tar.xz": x64,
    });
  });

  test("npmIntegrityHex converts npm's base64 sha512 to hex", () => {
    // sha512 of the empty string, base64: the known-answer vector.
    expect(
      npmIntegrityHex(
        "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="
      )
    ).toBe(
      "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
    );
    expect(npmIntegrityHex("sha1-deadbeef")).toBeUndefined();
  });

  test("githubAssetDigest reads the release asset's published digest", () => {
    const release = JSON.stringify({
      assets: [
        { digest: null, name: "duckdb.zip" },
        {
          digest:
            "sha256:c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc",
          name: "duckdb-cli-linux-amd64.tar.gz",
        },
      ],
    });

    expect(githubAssetDigest(release, "duckdb-cli-linux-amd64.tar.gz")).toBe(
      "c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc"
    );
    expect(githubAssetDigest(release, "missing.tar.gz")).toBeUndefined();
  });
});

describe("online comparators", () => {
  const sha512Empty =
    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e";

  test("a tag must resolve to exactly the pinned index digest", () => {
    const probe = {
      digest: "a".repeat(64),
      kind: "image" as const,
      name: "docker.io/library/x:1",
      url: "docker.io/library/x:1",
    };

    expect(
      verifyImageDigest(probe, `sha256:${"a".repeat(64)}`)
    ).toBeUndefined();
    expect(verifyImageDigest(probe, `sha256:${"b".repeat(64)}`)).toContain(
      "now resolves to sha256:bbbb"
    );
    expect(verifyImageDigest(probe, "")).toContain("now resolves to nothing");
  });

  test("a SHASUMS entry must match the pinned checksum", () => {
    const digest = "c".repeat(64);

    const probe = {
      entries: { "node-v1-linux-x64.tar.xz": digest },
      kind: "shasums" as const,
      name: "node",
      url: "https://nodejs.org/download/release/v1/SHASUMS256.txt",
    };

    expect(
      verifyFetchedPin(probe, `${digest}  node-v1-linux-x64.tar.xz\n`)
    ).toBeUndefined();
    expect(
      verifyFetchedPin(probe, `${"d".repeat(64)}  node-v1-linux-x64.tar.xz\n`)
    ).toContain("lists node-v1-linux-x64.tar.xz as");
    expect(verifyFetchedPin(probe, "")).toContain("as nothing");
  });

  test("npm integrity must convert to the pinned sha512", () => {
    const probe = {
      digest: sha512Empty,
      kind: "npm-integrity" as const,
      name: "@esbuild/linux-x64",
      url: "https://registry.npmjs.org/@esbuild/linux-x64/0.0.1",
    };

    expect(
      verifyFetchedPin(
        probe,
        JSON.stringify({
          dist: {
            integrity:
              "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
          },
        })
      )
    ).toBeUndefined();
    expect(
      verifyFetchedPin(probe, JSON.stringify({ dist: { integrity: "sha1-x" } }))
    ).toContain("publishes sha1-x");
  });

  test("a GitHub release asset must carry the pinned digest", () => {
    const probe = {
      asset: "duckdb-cli-linux-amd64.tar.gz",
      digest: "e".repeat(64),
      kind: "github-asset" as const,
      name: "duckdb amd64",
      url: "https://api.github.com/repos/duckdb/duckdb/releases/tags/v2.0.0",
    };

    expect(
      verifyFetchedPin(
        probe,
        JSON.stringify({
          assets: [
            {
              digest: `sha256:${"e".repeat(64)}`,
              name: "duckdb-cli-linux-amd64.tar.gz",
            },
          ],
        })
      )
    ).toBeUndefined();
    expect(verifyFetchedPin(probe, JSON.stringify({ assets: [] }))).toContain(
      "as no digest"
    );
  });
});
