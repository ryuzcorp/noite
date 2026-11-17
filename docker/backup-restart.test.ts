import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
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
//! The script runs from a copy in a temp tree (it cd's to its repo root and
//! loads `./.env`), so an operator's `.env` never leaks into a run.
const SRC = path.resolve(import.meta.dir);

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
        # A wedged up: the containers come up, the command still fails.
        if [ "$BK_UP_WEDGE" = 1 ]; then exit 1; fi
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
    # Ctrl-C or a CI timeout landing on the script mid-tar.
    if [ -n "$BK_TAR_SIGNAL" ]; then kill -s "$BK_TAR_SIGNAL" "$PPID"; sleep 1; fi
    ;;
  ps)
    # project_running asks per engine's compose labels: every container's
    # state, then the edge's (service=noite), then the bundled store's
    # (service=rustfs). Only the docker labels answer.
    # BK_EDGE_GONE: up removed the edge and failed to recreate it, so only
    # the dependency runs. BK_DEP_STATE: the dependency's state (podman
    # reports initialized / stopped for down containers). BK_STORE_STATE:
    # the rustfs service's own state, so a down store fails the restart
    # even when the project query above still lists every container
    # running. BK_STORE_GONE: a '--scale rustfs=0' install with no store
    # container at all.
    case "$*" in
      *com.docker.compose.service=noite*)
        if [ "$(state)" = running ] && [ "$BK_EDGE_GONE" != 1 ]; then printf 'running\n'; fi
        ;;
      *com.docker.compose.service=rustfs*)
        if [ "$BK_STORE_GONE" != 1 ]; then
          if [ "$(state)" != running ]; then printf 'exited\n'
          else store="$BK_STORE_STATE"; [ -n "$store" ] || store=running; printf '%s\n' "$store"; fi
        fi
        ;;
      *com.docker.compose.project=*)
        if [ "$(state)" != running ]; then printf 'exited\nexited\n'
        elif [ "$BK_EDGE_GONE" = 1 ]; then printf 'running\n'
        else dep="$BK_DEP_STATE"; [ -n "$dep" ] || dep=running; printf 'running\n%s\n' "$dep"; fi
        ;;
    esac
    ;;
  *) log "engine-$1" ;;
esac
exit 0
`;

const CURL_STUB = String.raw`#!/bin/sh
if [ "$BK_CURL_FAIL" = 1 ]; then exit 22; fi
exit 0
`;

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
}

interface BackupOpts {
  baseDomain?: string | null;
  curlFail?: boolean;
  depState?: string;
  edgeGone?: boolean;
  envFile?: string;
  tarSignal?: "INT" | "TERM";
  storeGone?: boolean;
  storeState?: string;
  tenancy?: string;
  tarFail?: boolean;
  upFail?: boolean;
  upWedge?: boolean;
}

const runBackup = (opts: BackupOpts = {}): RunResult & { log: string } => {
  const {
    baseDomain = "noite.localhost",
    curlFail,
    depState,
    edgeGone,
    envFile,
    tarSignal,
    tenancy,
    tarFail,
    storeGone,
    storeState,
    upFail,
    upWedge,
  } = opts;

  mkdirSync(fakebin, { recursive: true });
  writeFileSync(path.join(fakebin, "docker"), DOCKER_STUB, { mode: 0o755 });
  writeFileSync(path.join(fakebin, "curl"), CURL_STUB, { mode: 0o755 });

  const tree = path.join(dir, "tree");
  mkdirSync(path.join(tree, "docker"), { recursive: true });

  for (const name of ["backup.sh", "lib.sh"]) {
    copyFileSync(path.join(SRC, name), path.join(tree, "docker", name));
  }

  if (envFile !== undefined) {
    writeFileSync(path.join(tree, ".env"), envFile);
  }

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
    // null: no caller BASE_DOMAIN, so the tree's `.env` decides.
    BASE_DOMAIN: baseDomain ?? undefined,
    NOITE_API_URL: "http://127.0.0.1:9/v1",
    NOITE_BACKUP_IMAGE: "stub-image",
    BK_LOG: logFile,
    BK_STATE: stateFile,
    NOITE_TENANCY: tenancy,
    BK_TAR_FAIL: tarFail === true ? "1" : undefined,
    BK_TAR_SIGNAL: tarSignal,
    BK_UP_FAIL: upFail === true ? "1" : undefined,
    BK_UP_WEDGE: upWedge === true ? "1" : undefined,
    BK_CURL_FAIL: curlFail === true ? "1" : undefined,
    BK_DEP_STATE: depState,
    BK_EDGE_GONE: edgeGone === true ? "1" : undefined,
    BK_STORE_GONE: storeGone === true ? "1" : undefined,
    BK_STORE_STATE: storeState,
  };

  const proc = Bun.spawnSync(
    ["sh", path.join(tree, "docker", "backup.sh"), dest],
    {
      env,
      stderr: "pipe",
      stdin: new Uint8Array(),
      stdout: "pipe",
    }
  );

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

  test("a signal mid-backup still restarts the stack, with the signal's status", () => {
    for (const [signal, code] of [
      ["INT", 130],
      ["TERM", 143],
    ] as const) {
      const r = runBackup({ tarSignal: signal });
      expect(r.status).toBe(code);
      expect(r.stdout).not.toContain("backup complete:");
      expect(composeLines(r.log, "up")).toHaveLength(1);
    }
  });

  test("a failure before the stop never touches the stack", () => {
    const r = runBackup({ curlFail: true });
    expect(r.status).not.toBe(0);
    expect(composeLines(r.log, "stop")).toHaveLength(0);
    expect(composeLines(r.log, "up")).toHaveLength(0);
  });

  test("an up that fails with every container running still succeeds, with a note", () => {
    const r = runBackup({ upWedge: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("every container is running");
    expect(r.stdout).toContain("backup complete:");
  });

  test("a failed up that leaves only a dependency running fails loudly", () => {
    const r = runBackup({ edgeGone: true, upWedge: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("backup complete:");
    expect(r.stderr).toContain("automatic restart failed");
  });

  test("a failed up with a container in podman's initialized state fails loudly", () => {
    const r = runBackup({ depState: "initialized", upWedge: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("backup complete:");
    expect(r.stderr).toContain("automatic restart failed");
  });

  test("a wedged up with the bundled store down fails loudly", () => {
    const r = runBackup({ storeState: "exited", upWedge: true });

    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("backup complete:");
    expect(r.stderr).toContain("automatic restart failed");
  });

  test("a wedged up with no bundled store still succeeds, with a note", () => {
    const r = runBackup({ storeGone: true, upWedge: true });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("every container is running");
    expect(r.stdout).toContain("backup complete:");
  });

  test("a direct run follows the .env base domain to the multi overlay", () => {
    const r = runBackup({
      baseDomain: null,
      envFile: "BASE_DOMAIN=example.com\n",
    });

    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).toContain("compose.multi.yaml");
  });

  test("the caller's tenancy wins over the .env one", () => {
    const r = runBackup({
      envFile: "NOITE_TENANCY=multi\n",
      tenancy: "single",
    });

    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).not.toContain("multi");
  });
});
