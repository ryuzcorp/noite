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

//! `make restore` must always bring the stack back: the stop/replace/start
//! cycle runs `ce down` and then unpacks every tar, so any `set -e` abort
//! after the stop (a bad archive, a tar error, a missing volume) or a failed
//! `up -d` used to leave the stack stopped with no word about it. The restart
//! below therefore runs in an EXIT trap, a failed restart exits nonzero
//! without the success line, and the restart converges the same compose files
//! the Makefile drives (base plus the multi overlay on multi installs).
//!
//! Restore-specifics: the volumes may already be half-overwritten when the
//! failure lands, and restarting is still right (a stopped stack plus a
//! half-restored one is worse than a running one the operator can restore
//! over again) — but the run must never print "restored" over the failure.
//!
//! The engine is a stub `docker` on PATH: no daemon, no sleeps, no retries.
//! The script runs from a copy in a temp tree (it cd's to its repo root and
//! loads `./.env`), so an operator's `.env` never leaks into a run.
const SRC = path.resolve(import.meta.dir);

let dir: string;
let fakebin: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "noite-restore-restart-"));
  fakebin = path.join(dir, "fakebin");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const DOCKER_STUB = String.raw`#!/bin/sh
# Fake engine for restore-restart tests. $RS_LOG records calls, $RS_STATE
# holds the stack state ("running" or "stopped").
log() { printf '%s :: %s\n' "$1" "$*" >> "$RS_LOG"; }
state() { cat "$RS_STATE"; }
case "$1" in
  compose)
    full="$*"
    shift
    sub=""
    for a in "$@"; do
      case "$a" in down|stop|up|ps) sub="$a" ;; esac
    done
    printf 'compose-%s :: %s\n' "$sub" "$full" >> "$RS_LOG"
    case "$sub" in
      down|stop) printf 'stopped' > "$RS_STATE" ;;
      up)
        if [ "$RS_UP_FAIL" = 1 ]; then exit 1; fi
        printf 'running' > "$RS_STATE"
        # A wedged up: the containers come up, the command still fails.
        if [ "$RS_UP_WEDGE" = 1 ]; then exit 1; fi
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
    if [ "$RS_TAR_FAIL" = 1 ]; then exit 1; fi
    # Ctrl-C or a CI timeout landing on the script mid-untar.
    if [ -n "$RS_TAR_SIGNAL" ]; then kill -s "$RS_TAR_SIGNAL" "$PPID"; sleep 1; fi
    ;;
  ps)
    # project_running asks per engine's compose labels: every container's
    # state, then the edge's (service=noite). Only the docker labels answer.
    # RS_EDGE_GONE: up removed the edge and failed to recreate it, so only
    # the dependency runs. RS_DEP_STATE: the dependency's state (podman
    # reports initialized / stopped for down containers).
    case "$*" in
      *com.docker.compose.service=noite*)
        if [ "$(state)" = running ] && [ "$RS_EDGE_GONE" != 1 ]; then printf 'running\n'; fi
        ;;
      *com.docker.compose.project=*)
        if [ "$(state)" != running ]; then printf 'exited\nexited\n'
        elif [ "$RS_EDGE_GONE" = 1 ]; then printf 'running\n'
        else dep="$RS_DEP_STATE"; [ -n "$dep" ] || dep=running; printf 'running\n%s\n' "$dep"; fi
        ;;
    esac
    ;;
  *) log "engine-$1" ;;
esac
exit 0
`;

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
}

interface RestoreOpts {
  baseDomain?: string | null;
  depState?: string;
  edgeGone?: boolean;
  envFile?: string;
  from?: string | null;
  noManifest?: boolean;
  extraTars?: string[];
  tarSignal?: "INT" | "TERM";
  tenancy?: string;
  tarFail?: boolean;
  upFail?: boolean;
  upWedge?: boolean;
}

const scrubEnv = () => {
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

  return clean;
};

const prepareFromDir = (
  from: string | null,
  noManifest: boolean | undefined,
  extraTars: string[]
): string | undefined => {
  if (from === null) {
    return undefined;
  }

  if (from !== "auto") {
    return from;
  }

  const bk = path.join(dir, "bk");

  mkdirSync(bk, { recursive: true });

  if (!noManifest) {
    writeFileSync(path.join(bk, "MANIFEST"), "noite backup\n");
  }

  writeFileSync(path.join(bk, "noite-data.tar"), "fake-tar\n");

  for (const name of extraTars) {
    writeFileSync(path.join(bk, name), "fake-tar\n");
  }

  return bk;
};

const runRestore = (opts: RestoreOpts = {}): RunResult & { log: string } => {
  const {
    baseDomain = "noite.localhost",
    depState,
    edgeGone,
    envFile,
    from = "auto",
    noManifest,
    extraTars = [],
    tarSignal,
    tenancy,
    tarFail,
    upFail,
    upWedge,
  } = opts;

  mkdirSync(fakebin, { recursive: true });
  writeFileSync(path.join(fakebin, "docker"), DOCKER_STUB, { mode: 0o755 });

  const tree = path.join(dir, "tree");
  mkdirSync(path.join(tree, "docker"), { recursive: true });

  for (const name of ["restore.sh", "lib.sh"]) {
    copyFileSync(path.join(SRC, name), path.join(tree, "docker", name));
  }

  if (envFile !== undefined) {
    writeFileSync(path.join(tree, ".env"), envFile);
  }

  const logFile = path.join(dir, "calls.log");
  const stateFile = path.join(dir, "state");
  writeFileSync(logFile, "");
  writeFileSync(stateFile, "running");

  const fromArg = prepareFromDir(from, noManifest, extraTars);

  const clean = scrubEnv();

  const env = {
    ...clean,
    PATH: `${fakebin}:/usr/bin:/bin`,
    PROJECT: "rs-test",
    // null: no caller BASE_DOMAIN, so the tree's `.env` decides.
    BASE_DOMAIN: baseDomain ?? undefined,
    NOITE_BACKUP_IMAGE: "stub-image",
    RS_LOG: logFile,
    RS_STATE: stateFile,
    NOITE_TENANCY: tenancy,
    RS_TAR_FAIL: tarFail === true ? "1" : undefined,
    RS_TAR_SIGNAL: tarSignal,
    RS_UP_FAIL: upFail === true ? "1" : undefined,
    RS_UP_WEDGE: upWedge === true ? "1" : undefined,
    RS_DEP_STATE: depState,
    RS_EDGE_GONE: edgeGone === true ? "1" : undefined,
  };

  const args =
    fromArg === undefined
      ? [path.join(tree, "docker", "restore.sh")]
      : [path.join(tree, "docker", "restore.sh"), fromArg];

  const proc = Bun.spawnSync(["sh", ...args], {
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

describe("make restore restart", () => {
  test("a clean restore stops, unpacks, restarts, and reports success", () => {
    const r = runRestore();

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("restored.");
    expect(composeLines(r.log, "down")).toHaveLength(1);
    expect(composeLines(r.log, "up")).toHaveLength(1);
    expect(r.log.indexOf("compose-down")).toBeLessThan(
      r.log.indexOf("compose-up")
    );
  });

  test("a mid-restore untar failure still restarts the stack and exits nonzero", () => {
    const r = runRestore({ tarFail: true });

    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("restored.");
    expect(r.stdout).toContain("start the stack again");
    expect(composeLines(r.log, "down")).toHaveLength(1);
    expect(composeLines(r.log, "up")).toHaveLength(1);
  });

  test("a failed restart exits nonzero instead of printing success", () => {
    const r = runRestore({ upFail: true });

    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("restored.");
    expect(r.stderr).toContain("automatic restart failed");
  });

  test("a multi install restarts with the multi overlay", () => {
    const r = runRestore({ baseDomain: "example.com" });

    expect(r.status).toBe(0);
    const up = composeLines(r.log, "up");

    expect(up).toHaveLength(1);
    expect(up[0]).toContain("compose.multi.yaml");
    expect(composeLines(r.log, "down")[0]).toContain("compose.multi.yaml");
  });

  test("a single install restarts with the base file only", () => {
    const r = runRestore({ baseDomain: "noite.localhost" });

    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).not.toContain("multi");
  });

  test("an explicit single tenancy wins over a remote base", () => {
    const r = runRestore({ baseDomain: "example.com", tenancy: "single" });

    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).not.toContain("multi");
  });

  test("a signal mid-restore still restarts the stack, with the signal's status", () => {
    for (const [signal, code] of [
      ["INT", 130],
      ["TERM", 143],
    ] as const) {
      const r = runRestore({ tarSignal: signal });

      expect(r.status).toBe(code);
      expect(r.stdout).not.toContain("restored.");
      expect(composeLines(r.log, "up")).toHaveLength(1);
    }
  });

  test("a failure before the stop never touches the stack", () => {
    for (const r of [
      runRestore({ from: null }),
      runRestore({ from: path.join(dir, "does-not-exist") }),
      runRestore({ noManifest: true }),
    ]) {
      expect(r.status).not.toBe(0);
      expect(composeLines(r.log, "down")).toHaveLength(0);
      expect(composeLines(r.log, "up")).toHaveLength(0);
    }
  });

  test("an up that fails with every container running still succeeds, with a note", () => {
    const r = runRestore({ upWedge: true });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("every container is running");
    expect(r.stdout).toContain("restored.");
  });

  test("a failed up that leaves only a dependency running fails loudly", () => {
    const r = runRestore({ edgeGone: true, upWedge: true });

    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("restored.");
    expect(r.stderr).toContain("automatic restart failed");
  });

  test("a failed up with a container in podman's initialized state fails loudly", () => {
    const r = runRestore({ depState: "initialized", upWedge: true });

    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("restored.");
    expect(r.stderr).toContain("automatic restart failed");
  });

  test("a direct run follows the .env base domain to the multi overlay", () => {
    const r = runRestore({
      baseDomain: null,
      envFile: "BASE_DOMAIN=example.com\n",
    });

    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).toContain("compose.multi.yaml");
  });

  test("the caller's tenancy wins over the .env one", () => {
    const r = runRestore({
      envFile: "NOITE_TENANCY=multi\n",
      tenancy: "single",
    });

    expect(r.status).toBe(0);
    expect(composeLines(r.log, "up")[0]).not.toContain("multi");
  });

  test("a tarball with an unsafe name fails loud instead of injecting the helper shell", () => {
    const r = runRestore({ extraTars: ["evil;touch pwned.tar"] });

    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("restored.");
    expect(r.stderr).toContain("refusing to restore");
    expect(composeLines(r.log, "up")).toHaveLength(1);
  });

  test("the Makefile quotes its FROM argument", () => {
    const makefile = readFileSync(path.join(SRC, "..", "Makefile"), "utf-8");

    expect(makefile).toContain('sh docker/restore.sh "$(FROM)"');
  });
});
