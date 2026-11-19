import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

//! The upgrade lane's old side must boot and be probed with the previous
//! release's own lane files, never the tree's (a rename between releases
//! leaves the old stack failing the tree's readiness probes). `old_lane_files`
//! (docker/lib.sh) materializes those files from the release tag; sourcing
//! runs nothing (lib.sh only defines helpers).
const REPO = path.resolve(import.meta.dir, "..");
const LIB = path.join(REPO, "docker", "lib.sh");

const LANE_FILES = [
  "compose.yaml",
  "compose.e2e.yaml",
  "compose.slot.yaml",
  "doctor.sh",
  "lib.sh",
] as const;

let dir: string;
const fixtureRepos: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "noite-upg-lane-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });

  for (const repo of fixtureRepos.splice(0)) {
    rmSync(repo, { force: true, recursive: true });
  }
});

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

/** Run `body` under POSIX `sh` (the lane scripts are `#!/bin/sh`). */
const runSh = (body: string, cwd: string): RunResult => {
  const proc = Bun.spawnSync(["sh", "-c", body], {
    cwd,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    status: proc.exitCode,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
  };
};

const git = (repo: string, args: string): void => {
  const result = runSh(`git ${args}`, repo);

  if (result.status !== 0) {
    throw new Error(`git ${args} failed: ${result.stderr}`);
  }
};

/** A fixture "previous release": celld-era lane files under docker/, tagged. */
const seedFixtureRelease = (tag: string) => {
  const repo = mkdtempSync(path.join(tmpdir(), "noite-oldrel-"));
  fixtureRepos.push(repo);
  const docker = path.join(repo, "docker");
  mkdirSync(docker, { recursive: true });

  const files = {
    // Split so the fixture keeps a literal `${...}` compose default without
    // a template placeholder.
    "compose.yaml":
      "services:\n  noite:\n    environment:\n      RUNNER_FLEET_LOG: $" +
      "{RUNNER_FLEET_LOG:-error,celld=warn}\n",
    "compose.e2e.yaml": "# e2e overlay\n",
    "compose.slot.yaml": "# slot overlay\n",
    "doctor.sh":
      '#!/bin/sh\ncheck "celld control node health" curl -fs http://127.0.0.1:8090/.well-known/celld/health\n',
    "lib.sh": "# fixture lib\n",
  };

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(docker, name), content);
  }

  git(repo, "init -b main");
  git(repo, 'config user.email "test@example.com"');
  git(repo, 'config user.name "test"');
  git(repo, "add docker");
  git(repo, "commit -m fixture");
  git(repo, `tag ${tag}`);

  return { files, repo };
};

describe("old_lane_files", () => {
  test("materializes the tagged release's own files, not the worktree's", () => {
    const tag = "v0.1.0-test.1";
    const { files, repo } = seedFixtureRelease(tag);
    const dest = path.join(dir, "out");

    // The fixture worktree (the "tree") moves on while the tag stays: the
    // extraction must still yield the tag's content.
    writeFileSync(
      path.join(repo, "docker", "doctor.sh"),
      '#!/bin/sh\ncheck "cello control node health" curl -fs http://127.0.0.1:8090/.well-known/cello/health\n'
    );

    const result = runSh(`. "${LIB}"\nold_lane_files "${tag}" "${dest}"`, repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${dest}/docker\n`);

    for (const name of LANE_FILES) {
      const written = path.join(dest, "docker", name);
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, "utf-8")).toBe(files[name]);
    }

    // The lane executes the old doctor.sh directly (owner/group/other exec
    // bits are the trailing three octal digits of the mode).
    expect(
      statSync(path.join(dest, "docker", "doctor.sh"))
        .mode.toString(8)
        .slice(-3)
    ).toMatch(/[1357][1357][1357]/u);
  });

  test("refuses an unreachable tag instead of falling back to the tree's files", () => {
    const { repo } = seedFixtureRelease("v0.1.0-test.1");
    const dest = path.join(dir, "out");

    const result = runSh(
      `. "${LIB}"\nold_lane_files "v9.9.9-nope" "${dest}"`,
      repo
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fetch tags");
    expect(existsSync(path.join(dest, "docker", "doctor.sh"))).toBe(false);
  });
});
