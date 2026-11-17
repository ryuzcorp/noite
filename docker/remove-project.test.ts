import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

//! `remove_project` (docker/lib.sh): beyond the compose-labeled containers,
//! reap sibling containers the stack spawned through the engine socket that
//! still mount the project's volumes (the sandbox relay mounts the data
//! volume with only a `noite.relay` label). One left holding a volume fails
//! the volume rm with "volume is in use" — the upgrade lane died at
//! teardown after going green.
const REPO = path.resolve(import.meta.dir, "..");
const LIB = path.join(REPO, "docker", "lib.sh");
let dir: string;
let fakeBin: string;
let fakeState: string;

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

/**
 * A fake engine CLI backed by `$FAKESTATE` files: `containers/<id>` holds
 * `label <k=v>` and `volume <name>` lines, `volumes/<name>` marks a volume
 * present, every invocation appends to `calls`. `volume rm` fails with the
 * daemon's "volume is in use" while a container file still mounts the
 * volume.
 */
const FAKE_ENGINE = `#!/bin/sh
state="$FAKESTATE"
echo "$*" >> "$state/calls"
case "$1" in
  ps)
    shift
    filter=""
    while [ $# -gt 0 ]; do
      case "$1" in
        *=*) filter="$1"; shift ;;
        *) shift ;;
      esac
    done
    kind="$(printf '%s' "$filter" | sed 's/=.*//')"
    want="$(printf '%s' "$filter" | sed 's/^[^=]*=//')"
    for c in "$state"/containers/*; do
      [ -f "$c" ] || continue
      if [ "$kind" = "volume" ]; then
        grep -qx "volume $want" "$c" && basename "$c"
      else
        grep -qx "label $want" "$c" && basename "$c"
      fi
    done
    ;;
  rm)
    shift
    [ "$1" = "-f" ] && shift
    for id in "$@"; do rm -f "$state/containers/$id"; done
    ;;
  volume)
    case "$2" in
      ls) ls "$state/volumes" 2>/dev/null || true ;;
      rm)
        shift 2
        [ "$1" = "-f" ] && shift
        for v in "$@"; do
          if grep -rlx "volume $v" "$state"/containers 2>/dev/null | grep -q .; then
            echo "Error response from daemon: remove $v: volume is in use" >&2
            exit 1
          fi
          rm -f "$state/volumes/$v"
        done
        ;;
    esac
    ;;
esac
`;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "noite-remove-project-"));
  fakeBin = path.join(dir, "bin");
  fakeState = path.join(dir, "state");
  mkdirSync(path.join(fakeState, "containers"), { recursive: true });
  mkdirSync(path.join(fakeState, "volumes"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  const engine = path.join(fakeBin, "docker");

  writeFileSync(engine, FAKE_ENGINE);
  chmodSync(engine, 0o755);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const calls = (): string => {
  try {
    return readFileSync(path.join(fakeState, "calls"), "utf-8");
  } catch {
    return "";
  }
};

const removeProject = (project: string): RunResult =>
  runBash(`source "$LIB"\nCLI="${fakeBin}/docker" remove_project ${project}`, {
    FAKESTATE: fakeState,
  });

describe("remove_project", () => {
  test("reaps an unlabeled volume holder before the volume rm", () => {
    writeFileSync(path.join(fakeState, "volumes", "test_noite-data"), "");
    writeFileSync(
      path.join(fakeState, "containers", "relay"),
      "label noite.relay=dead-owner\nvolume test_noite-data\n"
    );

    const r = removeProject("test");

    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/volume is in use/u);

    const log = calls();
    const holderRm = log.indexOf("rm -f relay");
    const volumeRm = log.indexOf("volume rm -f test_noite-data");

    expect(holderRm).toBeGreaterThanOrEqual(0);
    expect(volumeRm).toBeGreaterThanOrEqual(0);
    expect(holderRm).toBeLessThan(volumeRm);
  });

  test("a clean project removes labeled containers and volumes", () => {
    writeFileSync(path.join(fakeState, "volumes", "test_noite-data"), "");
    writeFileSync(
      path.join(fakeState, "containers", "noite"),
      "label com.docker.compose.project=test\nvolume test_noite-data\n"
    );

    const r = removeProject("test");

    expect(r.status).toBe(0);

    const log = calls();

    expect(log).toContain("rm -f noite");
    expect(log).toContain("volume rm -f test_noite-data");
  });

  test("no volumes is a successful no-op", () => {
    const r = removeProject("test");

    expect(r.status).toBe(0);
    expect(calls()).not.toContain("volume rm");
  });
});
