import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

//! `require_private_dir` (docker/lib.sh): the backup destination holds
//! plaintext secrets, so a fresh directory lands at 0700 whatever the
//! caller's umask is, and a pre-existing group/world-accessible directory
//! is refused instead of silently re-permissioned.
const REPO = path.resolve(import.meta.dir, "..");
const LIB = path.join(REPO, "docker", "lib.sh");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "noite-backup-perms-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
}

/** Run `body` with lib.sh sourced; stdin is empty so nothing can hang. */
const runBash = (body: string, env: Record<string, string> = {}): RunResult => {
  const clean: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("NOITE_")) {
      clean[key] = value;
    }
  }

  const proc = Bun.spawnSync(["bash", "-c", body], {
    env: { ...clean, ...env, LIB },
    stderr: "pipe",
    stdin: new Uint8Array(),
    stdout: "pipe",
  });

  return {
    status: proc.exitCode,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
  };
};

/** Last three octal digits of a path's mode (no bitwise lint). */
const modeOf = (target: string): string =>
  statSync(target).mode.toString(8).slice(-3);

describe("require_private_dir", () => {
  test("creates a fresh destination 0700 under a permissive umask", () => {
    const dest = path.join(dir, "backups", "20260101T000000Z");

    const r = runBash(
      `source "$LIB"\numask 022\nrequire_private_dir "${dest}"`
    );

    expect(r.status).toBe(0);
    expect(modeOf(dest)).toBe("700");
  });

  test("refuses a pre-existing world-readable directory and leaves it alone", () => {
    const dest = path.join(dir, "shared");

    const r = runBash(
      `source "$LIB"\nmkdir -p "${dest}"\nchmod 755 "${dest}"\nrequire_private_dir "${dest}"`
    );

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/group- or world-accessible/u);
    expect(modeOf(dest)).toBe("755");
  });

  test("accepts a pre-existing private directory", () => {
    const dest = path.join(dir, "private");

    const r = runBash(
      `source "$LIB"\nmkdir -p "${dest}"\nchmod 700 "${dest}"\nrequire_private_dir "${dest}"`
    );

    expect(r.status).toBe(0);
    expect(modeOf(dest)).toBe("700");
  });

  test.each([["740"], ["750"], ["701"], ["710"]])(
    "refuses a pre-existing %s directory",
    (mode) => {
      const dest = path.join(dir, `mode-${mode}`);

      const r = runBash(
        `source "$LIB"\nmkdir -p "${dest}"\nchmod ${mode} "${dest}"\nrequire_private_dir "${dest}"`
      );

      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/group- or world-accessible/u);
      expect(modeOf(dest)).toBe(mode);
    }
  );
});
