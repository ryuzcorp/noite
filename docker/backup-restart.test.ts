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

//! `make backup` must always bring the stack back: the stop/tar/start cycle
//! runs `ce stop` and then tars the volumes, so any `set -e` abort after the
//! stop (a tar error, a full disk) or a failed `up -d` used to leave both
//! containers `Exited (0)` with a "backup complete" on stdout (beta.1
//! dogfood bug 3). The restart below therefore runs in an EXIT trap, a
//! failed restart exits nonzero without the success line, and the restart
//! converges the same compose files the Makefile drives (base plus the
//! multi overlay on multi installs).
//!
//! The engine is a stub `docker` on PATH: no daemon, no sleeps, no retries.
const REPO = path.resolve(import.meta.dir, "..");
const BACKUP = path.join(REPO, "docker", "backup.sh");

let dir: string;
let fakebin: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "noite-backup-restart-"));
  fakebin = path.join(dir, "fakebin");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const DOCKER_STUB = String.raw`#!/bin/sh
# Fake engine for backup-restart tests. $BK_LOG records calls, $BK_STATE
# holds the stack state ("running" or "stopped").
log() { printf '%s :: %s\n' "$1" "$*" >> "$BK_LOG"; }
state() { cat "$BK_STATE"; }
case "$1" in
  compose)
    full="$*"
    shift
    sub=""
    for a in "$@"; do
      case "$a" in stop|up|ps) sub="$a" ;; esac
    done
    printf 'compose-%s :: %s\n' "$sub" "$full" >> "$BK_LOG"
    case "$sub" in
      stop) printf 'stopped' > "$BK_STATE" ;;
      up)
        if [ "$BK_UP_FAIL" = 1 ]; then exit 1; fi
        printf 'running' > "$BK_STATE"
        ;;
      ps)
        if [ "$(state)" = running ]; then printf 'running\nrunning\n'; else printf 'exited\nexited\n'; fi
        ;;
    esac
    ;;
  image) log "engine-image" ;;
  volume) log "engine-volume" ;;
  run)
    log "engine-run"
    if [ "$BK_TAR_FAIL" = 1 ]; then exit 1; fi
    ;;
  *) log "engine-$1" ;;
esac
exit 0
`;

const CURL_STUB = String.raw`#!/bin/sh
exit 0
`;

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
}

interface BackupOpts {
  baseDomain?: string;
  tenancy?: string;
  tarFail?: boolean;
  upFail?: boolean;
}

const runBackup = (opts: BackupOpts = {}): RunResult & { log: string } => {
  const { baseDomain = "noite.localhost", tenancy, tarFail, upFail } = opts;
  mkdirSync(fakebin, { recursive: true });
  Bun.write(path.join(fakebin, "docker"), DOCKER_STUB);
  Bun.write(path.join(fakebin, "curl"), CURL_STUB);
  chmodSync(path.join(fakebin, "docker"), 0o755);
  chmodSync(path.join(fakebin, "curl"), 0o755);
  const logFile = path.join(dir, "calls.log");
  const stateFile = path.join(dir, "state");
  writeFileSync(logFile, "");
  writeFileSync(stateFile, "running");
  const dest = path.join(dir, "backups", "STAMP");

  const clean: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      !key.startsWith("NOITE_") &&
      key !== "PROJECT" &&
      key !== "COMPOSE" &&
      key !== "COMPOSE_FILES" &&
      key !== "COMPOSE_PROJECT_NAME"
    ) {
      clean[key] = value;
    }
  }

  const env = {
    ...clean,
    PATH: `${fakebin}:/usr/bin:/bin`,
    PROJECT: "bk-test",
    BASE_DOMAIN: baseDomain,
    NOITE_API_URL: "http://127.0.0.1:9/v1",
    NOITE_BACKUP_IMAGE: "stub-image",
    BK_LOG: logFile,
    BK_STATE: stateFile,
    NOITE_TENANCY: tenancy,
    BK_TAR_FAIL: tarFail === true ? "1" : undefined,
    BK_UP_FAIL: upFail === true ? "1" : undefined,
  };

  const proc = Bun.spawnSync(["sh", BACKUP, dest], {
    env,
    stderr: "pipe",
    stdin: new Uint8Array(),
    stdout: "pipe",
  });

  return {
    status: proc.exitCode,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
    log: readFileSync(logFile, "utf-8"),
  };
};

const composeLines = (log: string, sub: string): string[] =>
  log.split("\n").filter((line) => line.startsWith(`compose-${sub} ::`));

describe("make backup restart", () => {
  test("a clean backup stops, tars, restarts, and reports success", () => {
    const r = runBackup();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backup complete:");
    expect(composeLines(r.log, "stop")).toHaveLength(1);
    expect(composeLines(r.log, "up")).toHaveLength(1);
    expect(r.log.indexOf("compose-stop")).toBeLessThan(
      r.log.indexOf("compose-up")
    );
  });

  test("a mid-backup tar failure still restarts the stack and exits nonzero", () => {
    const r = runBackup({ tarFail: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("backup complete:");
    expect(r.stdout).toContain("start the stack again");
    expect(composeLines(r.log, "stop")).toHaveLength(1);
    expect(composeLines(r.log, "up")).toHaveLength(1);
  });

  test("a failed restart exits nonzero instead of printing success", () => {
    const r = runBackup({ upFail: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("backup complete:");
    expect(r.stderr).toContain("automatic restart failed");
  });

  test("a multi install restarts with the multi overlay", () => {
    const r = runBackup({ baseDomain: "example.com" });
    expect(r.status).toBe(0);
    const up = composeLines(r.log, "up");
    expect(up).toHaveLength(1);
    expect(up[0]).toContain("compose.multi.yaml");
    expect(composeLines(r.log, "stop")[0]).toContain("compose.multi.yaml");
  });

  test("a single install restarts with the base file only", () => {
    const r = runBackup({ baseDomain: "noite.localhost" });
    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).not.toContain("multi");
  });

  test("an explicit single tenancy wins over a remote base", () => {
    const r = runBackup({ baseDomain: "example.com", tenancy: "single" });
    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).not.toContain("multi");
  });
});
