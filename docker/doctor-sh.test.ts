import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

//! doctor.sh's generation gate (the 0.2.0 beta reset): the runner refuses
//! pre-reset data on stderr, so the boot-log capture must merge stderr, and
//! the verdict must match the reset-specific marker — `Plan::TooNew` also
//! says "refusing to start" + "cannot be upgraded", and misreading it as
//! pre-reset tells the operator to delete volumes. The whole script runs
//! with a fake `docker` (ps/exec/logs) and a failing `curl`.
const REPO = path.resolve(import.meta.dir, "..");
const DOCTOR = path.join(REPO, "docker", "doctor.sh");

const PRE_RESET_REFUSAL =
  "refusing to start: this database was written by a Noite release before the 0.2.0 beta reset and cannot be upgraded. Back it up if you need it, wipe the data volume and the bucket prefix (or use an empty bucket), then install fresh.";

const TOO_NEW_REFUSAL =
  "refusing to start: this database was written by a newer Noite release (schema version 201; this image only understands up to 200). Install the image matching that schema version, or restore a backup taken before the upgrade. Downgrading across a schema change is not supported.";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "noite-doctor-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
}

/** Run the real doctor.sh with every external touch faked. `logs` prints
 * `out` on stdout and `err` on stderr to prove which stream the capture
 * reads; `ready` is the `/ready` body (never ok here). */
const runDoctor = (args: {
  ready?: string;
  out?: string;
  err?: string;
  exit?: number;
}): RunResult => {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  // SAFETY: test-only fake; quoted env values never reach a shell unquoted
  // beyond this printf (single shell, no eval of the values).
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
case "$1" in
  ps) echo "deadbeef testproj_noite_1" ;;
  exec) printf '%s' "$FAKE_READY" ;;
  logs) printf '%s' "$FAKE_OUT"; printf '%s' "$FAKE_ERR" >&2; exit "$FAKE_EXIT" ;;
esac
`
  );
  writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 1\n");

  for (const name of ["docker", "curl"]) {
    Bun.spawnSync(["chmod", "+x", path.join(bin, name)]);
  }

  const proc = Bun.spawnSync(["sh", DOCTOR], {
    env: {
      ...process.env,
      FAKE_ERR: args.err ?? "",
      FAKE_EXIT: String(args.exit ?? 0),
      FAKE_OUT: args.out ?? "",
      FAKE_READY: args.ready ?? '{"ok":false}',
      PATH: `${bin}:${process.env.PATH}`,
      PROJECT: "testproj",
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    status: proc.exitCode,
    stdout: proc.stdout.toString(),
  };
};

describe("doctor.sh generation gate", () => {
  test("a pre-reset refusal on stderr is diagnosed", () => {
    const result = runDoctor({ err: `boom\n${PRE_RESET_REFUSAL}\n` });

    expect(result.stdout).toContain("FAIL pre-reset data");
  });

  test("a pre-reset refusal on stdout is diagnosed", () => {
    const result = runDoctor({ out: PRE_RESET_REFUSAL });

    expect(result.stdout).toContain("FAIL pre-reset data");
  });

  test("a newer-schema refusal is not a pre-reset verdict", () => {
    const result = runDoctor({ err: TOO_NEW_REFUSAL, out: TOO_NEW_REFUSAL });

    expect(result.stdout).not.toContain("FAIL pre-reset data");
    expect(result.stdout).toContain("newer Noite release");
  });
});
