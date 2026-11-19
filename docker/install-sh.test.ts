import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

//! install.sh's admin-email plumbing: the env-writing functions run against a
//! temp `NOITE_DIR` with the network-touching helpers stubbed (domain choice,
//! download, terminal). Sourcing runs nothing (the `BASH_SOURCE` guard); each
const REPO = path.resolve(import.meta.dir, "..");
const INSTALL = path.join(REPO, "docker", "install.sh");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "noite-install-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

/** Run `body` in bash with the installer sourced and the volatile helpers
 * stubbed. `env` reaches the shell; stdin is empty so a stray terminal read
 * fails fast instead of hanging. The ambient `NOITE_*` variables are
 * scrubbed — the operator's own shell may export them (notably
 * `NOITE_ADMIN_EMAIL`), and every case sets exactly what it needs. */
const runBash = (body: string, env: Record<string, string> = {}): RunResult => {
  const clean: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("NOITE_")) {
      clean[key] = value;
    }
  }

  const proc = Bun.spawnSync(["bash", "-c", body], {
    env: { ...clean, ...env, NOITE_DIR: dir },
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

const PRELUDE = `
source "${INSTALL}"
choose_domain() { DOMAIN="$NOITE_DOMAIN"; }
curl() { local out="" prev=""; for a in "$@"; do if [[ "$prev" == "-o" ]]; then out="$a"; fi; prev="$a"; done; printf 'services:\\napparmor:\\n' > "$out"; }
`;

const readEnv = (): string => readFileSync(path.join(dir, ".env"), "utf-8");

/** Whether `main` reached any step after the pre-reset refusal (see below). */
const stepsRan = (): boolean => existsSync(path.join(dir, "steps"));

/** An uncommented `KEY=` line (the template comments mention several keys). */
const hasActive = (env: string, key: string): boolean =>
  env.split("\n").some((line) => line.startsWith(`${key}=`));

describe("install.sh admin email", () => {
  test("an explicit env address is validated and persisted on a fresh install", () => {
    const result = runBash(`${PRELUDE}\nwrite_config`, {
      NOITE_ADMIN_EMAIL: "op@example.com",
      NOITE_DOMAIN: "example.com",
    });

    expect(result.status).toBe(0);
    expect(readEnv()).toContain("NOITE_ADMIN_EMAIL=op@example.com");
    expect(readEnv()).toContain("BASE_DOMAIN=example.com");
  });

  test("an invalid env address fails the install loudly", () => {
    const result = runBash(
      `${PRELUDE}
       touch "$NOITE_DIR/.env"
       ( NOITE_ADMIN_EMAIL="not-an-email" choose_admin_email )`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NOITE_ADMIN_EMAIL");
  });

  // .env is sourced by bash (docker/lib.sh load_env), so an address carrying
  // shell syntax must never reach it: it would run as root on the next load.
  test("an address with shell syntax is refused and never written", () => {
    for (const hostile of [
      "a$(touch pwned)@example.com",
      "a`id`@example.com",
      "a'b@example.com",
      'a"b@example.com',
      "a;id@example.com",
      "a$HOME@example.com",
      "a@example",
    ]) {
      writeFileSync(path.join(dir, ".env"), "BASE_DOMAIN=example.com\n");

      const result = runBash(
        `${PRELUDE}
         ( choose_admin_email )`,
        { NOITE_ADMIN_EMAIL: hostile, NOITE_DOMAIN: "example.com" }
      );

      expect(result.status).not.toBe(0);
      expect(readEnv()).not.toContain("NOITE_ADMIN_EMAIL=");
    }
  });

  test("a kept .env value survives a re-run without a prompt", () => {
    writeFileSync(
      path.join(dir, ".env"),
      "BASE_DOMAIN=example.com\nNOITE_ADMIN_EMAIL=old@example.com\n"
    );

    const result = runBash(
      `${PRELUDE}
       can_ask() { echo "PROMPTED"; return 0; }
       ask() { echo "ASK-CALLED"; return 1; }
       write_config
       echo "canary=$?"`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("PROMPTED");
    expect(result.stdout).not.toContain("ASK-CALLED");
    expect(readEnv()).toContain("NOITE_ADMIN_EMAIL=old@example.com");
  });

  test("an explicit env address replaces a kept one", () => {
    writeFileSync(
      path.join(dir, ".env"),
      "BASE_DOMAIN=example.com\nNOITE_ADMIN_EMAIL=old@example.com\n"
    );

    const result = runBash(`${PRELUDE}\nwrite_config`, {
      NOITE_ADMIN_EMAIL: "new@example.com",
      NOITE_DOMAIN: "example.com",
    });

    expect(result.status).toBe(0);
    expect(readEnv()).toContain("NOITE_ADMIN_EMAIL=new@example.com");
    expect(readEnv()).not.toContain("old@example.com");
  });

  test("no terminal and no address leaves the setup-code path", () => {
    const result = runBash(
      `${PRELUDE}
       can_ask() { return 1; }
       write_config`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("one-time setup code");
    expect(hasActive(readEnv(), "NOITE_ADMIN_EMAIL")).toBe(false);
  });

  test("an interactive answer is persisted, with a re-prompt on bad input", () => {
    const result = runBash(
      `${PRELUDE}
       can_ask() { return 0; }
       answers=("not-an-email" "op@example.com"); idx=0
       ask() { answer="\${answers[$idx]}"; idx=$((idx + 1)); }
       write_config`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("not-an-email");
    expect(readEnv()).toContain("NOITE_ADMIN_EMAIL=op@example.com");
  });

  test("an empty interactive answer keeps the setup-code path", () => {
    const result = runBash(
      `${PRELUDE}
       can_ask() { return 0; }
       ask() { answer=""; }
       write_config`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).toBe(0);
    expect(hasActive(readEnv(), "NOITE_ADMIN_EMAIL")).toBe(false);
  });

  test("localhost never prompts and never persists", () => {
    const result = runBash(
      `${PRELUDE}
       can_ask() { echo "PROMPTED"; return 0; }
       write_config`,
      { NOITE_DOMAIN: "noite.localhost" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("PROMPTED");
    expect(hasActive(readEnv(), "NOITE_ADMIN_EMAIL")).toBe(false);
  });
});

describe("install.sh --admin-email flag", () => {
  test("both flag forms set the address for the run", () => {
    const spaced = runBash(
      `source "${INSTALL}"\nparse_args --admin-email flag@example.com --yes\necho "email=$NOITE_ADMIN_EMAIL confirm=$CONFIRM_SKIP"`
    );

    expect(spaced.status).toBe(0);
    expect(spaced.stdout).toContain("email=flag@example.com confirm=1");

    const joined = runBash(
      `source "${INSTALL}"\nparse_args --admin-email=eq@example.com\necho "email=$NOITE_ADMIN_EMAIL"`
    );

    expect(joined.status).toBe(0);
    expect(joined.stdout).toContain("email=eq@example.com");
  });

  test("a missing flag value fails loudly", () => {
    const result = runBash(`source "${INSTALL}"\nparse_args --admin-email`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--admin-email needs an address");
  });

  test("a flag address reaches the fresh .env", () => {
    const result = runBash(
      `${PRELUDE}\nparse_args --admin-email flag@example.com\nwrite_config`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).toBe(0);
    expect(readEnv()).toContain("NOITE_ADMIN_EMAIL=flag@example.com");
  });
});

describe("install.sh first-run note", () => {
  const NOTE_PRELUDE = `
source "${INSTALL}"
DOMAIN="example.com"
compose() {
  if [[ "$1 $2 $3" == "exec -T noite" ]]; then
    printf 'Setup code for this install'"'"'s first admin: CODE-1\\nsecond line\\n'
    return 0
  fi
  return 0
}
`;

  test("a reserved address names who must register first, with the code", () => {
    writeFileSync(
      path.join(dir, ".env"),
      "BASE_DOMAIN=example.com\nNOITE_ADMIN_EMAIL=op@example.com\n"
    );
    const result = runBash(`${NOTE_PRELUDE}\nfirst_run_note`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("op@example.com");
    expect(result.stdout).toContain("CODE-1");
  });

  test("without an address the minted code is printed", () => {
    writeFileSync(path.join(dir, ".env"), "BASE_DOMAIN=example.com\n");
    const result = runBash(`${NOTE_PRELUDE}\nfirst_run_note`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CODE-1");
  });

  test("an unreachable container falls back to the manual command", () => {
    writeFileSync(path.join(dir, ".env"), "BASE_DOMAIN=example.com\n");

    const result = runBash(
      `${NOTE_PRELUDE}\ncompose() { return 1; }\nfirst_run_note`
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("noite-runner setup-code");
    expect(result.stdout).not.toContain("CODE-1");
  });

  test("localhost keeps the no-code wording", () => {
    writeFileSync(path.join(dir, ".env"), "BASE_DOMAIN=noite.localhost\n");

    const result = runBash(
      `${NOTE_PRELUDE}\nDOMAIN="noite.localhost"\nfirst_run_note`
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("needs no code");
  });
});

describe("install.sh pre-reset refusal", () => {
  // `main` with every step after the refusal stubbed to record that it ran:
  // a refused install must touch nothing on the host, not just the .env.
  const MAIN = `${PRELUDE}
check_system() { :; }
for step in install_docker ensure_swap check_ports write_config open_firewall start_stack summary; do
  eval "$step() { echo $step >>\\"\\$NOITE_DIR/steps\\"; }"
done
main`;

  test("a .env with any CELLD_* key is refused with reinstall steps, untouched", () => {
    const before =
      "BASE_DOMAIN=example.com\nCELLD_ADVERTISE=peer\nNOITE_IMAGE=ghcr.io/ryuzcorp/noite:alpha\n";

    writeFileSync(path.join(dir, ".env"), before);

    const result = runBash(MAIN, { NOITE_DOMAIN: "example.com" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot be upgraded");
    expect(result.stderr).toContain("before the 0.2.0 beta reset");
    expect(result.stderr).toContain("down -v");
    // The reinstall only works when the stale .env is moved aside first:
    // `down -v` leaves the file behind and the next run refuses again.
    expect(result.stderr).toContain("move the old .env aside");
    expect(result.stderr).toContain("re-run");
    expect(readEnv()).toBe(before);
    expect(stepsRan()).toBe(false);
  });

  test("a .env pinned to a 0.1.0 image is refused with reinstall steps, untouched", () => {
    for (const pin of ["0.1.0-beta.6", "0.1.0-alpha.5"]) {
      const before = `BASE_DOMAIN=example.com\nNOITE_IMAGE=ghcr.io/ryuzcorp/noite:${pin}\n`;
      writeFileSync(path.join(dir, ".env"), before);

      const result = runBash(MAIN, { NOITE_DOMAIN: "example.com" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cannot be upgraded");
      expect(result.stderr).toContain("down -v");
      expect(readEnv()).toBe(before);
      expect(stepsRan()).toBe(false);
    }
  });

  test("--yes does not bypass the refusal", () => {
    writeFileSync(
      path.join(dir, ".env"),
      "BASE_DOMAIN=example.com\nCELLD_BIN=cello\n"
    );

    const result = runBash(`${MAIN} --yes`, {
      NOITE_DOMAIN: "example.com",
      NOITE_YES: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot be upgraded");
    expect(stepsRan()).toBe(false);
  });

  test("a current-generation .env passes the refusal and main runs every step", () => {
    writeFileSync(
      path.join(dir, ".env"),
      "BASE_DOMAIN=example.com\nCELLO_BIN=cello\n"
    );

    const result = runBash(MAIN, { NOITE_DOMAIN: "example.com" });

    expect(result.status).toBe(0);
    expect(stepsRan()).toBe(true);
  });

  test("a current-generation .env still upgrades in place", () => {
    writeFileSync(
      path.join(dir, ".env"),
      "BASE_DOMAIN=example.com\nCELLO_BIN=cello\n"
    );

    const result = runBash(
      `${PRELUDE}\ncan_ask() { return 1; }\nwrite_config`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).toBe(0);
    expect(readEnv()).toContain("CELLO_BIN=cello");
  });

  test("a fresh install without a .env proceeds", () => {
    const result = runBash(
      `${PRELUDE}\ncan_ask() { return 1; }\nwrite_config`,
      { NOITE_DOMAIN: "example.com" }
    );

    expect(result.status).toBe(0);
  });
});

describe("install.sh entrypoint", () => {
  test("run.sh-style execution (bash -c, unset BASH_SOURCE) reaches main", () => {
    // run.sh invokes the installer as `bash -c "$script" install.sh`, where
    // BASH_SOURCE is unset: with `set -u` the old guard aborted before main.
    // `id` is stubbed (the script never defines it) so check_system dies
    // with its root refusal instead of running the install — as any user.
    const result = runBash(
      `id() { echo 1000; }\nexport -f id\nscript=$(cat "${INSTALL}")\nbash -c "$script" install.sh`
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("run as root");
    expect(result.stderr).not.toContain("BASH_SOURCE");
  });

  test("sourcing defines functions without running the install", () => {
    const result = runBash(
      `id() { echo 1000; }\nsource "${INSTALL}"\necho "SOURCED"\ntype main`
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SOURCED");
    expect(result.stderr).not.toContain("run as root");
  });
});
