import { defineConfig } from "@playwright/test";

// Raw-port lane locally (control UI through Caddy on noite.localhost:8090;
// runner API direct on localhost:8080; tenants on their 81xx ports). No Caddy
// site per app, no /etc/hosts entry: the lane's base is `*.localhost`, which
// the browser resolves to loopback and treats as a secure context (the
// WebAuthn RP ID must be a host, never 127.0.0.1).
const baseURL = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

// Spec files run in parallel across workers (E2E_WORKERS, default 3: the lane
// is deploy-bound, and each worker mostly idles while the runner builds).
// Tests within one file stay serial (fullyParallel: false): files own their
// slugs and cleanup arrays, and afterEach/afterAll hooks assume no in-flight
// sibling test. Every file is hermetic — its own apps, its own deploys —
// except the two ordered projects below, so any file may run beside any
// other. Shared lane resources are bounded instead: the app quota is raised
// for the lane (compose.e2e.yaml) and invite-code redemption is file-locked
// (e2e/helpers.ts). Runner capacity note: deploys have no global semaphore
// (per-app locks only), so concurrent deploys contend on CPU but proceed;
// each deploy keeps its 8-minute budget, and 3 workers leave headroom on a
// 4-vCPU GitHub runner.
// Sharding across CI jobs (E2E_SHARD="<current>/<total>", set by e2e.yml):
// each shard still runs the setup and policy dependency projects in full
// (verified: Playwright repeats project dependencies on every shard), so
// every shard signs up and probes policy beside its half of the bulk. Unset
// locally means today's behaviour: one unsharded run.
const shardValue = process.env.E2E_SHARD;
let shard: { current: number; total: number } | undefined;

if (shardValue !== undefined && shardValue !== "") {
  const match = /^(?<current>\d+)\/(?<total>\d+)$/u.exec(shardValue);
  const current = Number(match?.groups?.current);
  const total = Number(match?.groups?.total);

  if (match === null || total < 1 || current < 1 || current > total) {
    throw new Error(`E2E_SHARD must be "<current>/<total>", not ${shardValue}`);
  }

  shard = { current, total };
}

const workers = Number(process.env.E2E_WORKERS ?? 3);

// Two suites over the same specs (E2E_SUITE, set by docker/e2e-local.sh):
// `release` (the default) runs everything; `fast` is the pull-request gate,
// the tests tagged for this lane's tenancy. `@fast` marks the single lane's
// critical user paths (create, push and deploy, live logs, Code mode push, PR
// merge, auth and invite gates, template deploy, rollback, environments,
// error ingest); `@isolation` marks the multi lane's set, the paths
// `NOITE_TENANCY=multi` changes (the hostile tenant, a sandboxed deploy, domain
// verification). A tag is opt-in on purpose: a new test joins the release
// suite, and joining the gate every pull request waits on is a decision. The
// setup and policy projects run in both suites (every other test needs them).
const SUITE_TAGS = {
  multi: /@isolation/u,
  single: /@fast/u,
};

const suite = process.env.E2E_SUITE ?? "release";

if (suite !== "fast" && suite !== "release") {
  throw new Error(`E2E_SUITE must be fast or release, not ${suite}`);
}

const tenancy = process.env.E2E_TENANCY ?? "single";

if (tenancy !== "single" && tenancy !== "multi") {
  throw new Error(`E2E_TENANCY must be single or multi, not ${tenancy}`);
}

// Parallel lanes (E2E_SLOT, set by docker/e2e-local.sh) keep their Playwright
// state apart: two lanes in one checkout must not share a cookie jar
// (cookies ignore ports, so one .auth dir would cross logins), a report dir
// or a test-results dir. Slot 0 keeps today's paths.
const authFile = process.env.E2E_AUTH_DIR
  ? `${process.env.E2E_AUTH_DIR}/user.json`
  : "e2e/.auth/user.json";

const suiteGrep = suite === "fast" ? SUITE_TAGS[tenancy] : undefined;

export default defineConfig({
  expect: { timeout: 30_000 },
  fullyParallel: false,
  // A stuck worker (a synchronously-blocked event loop — a hung `git` child
  // froze its worker in merge-queue run 39785255412, so no per-test or hook
  // timeout could fire) defeats every in-worker timeout. This parent-side
  // bound trips instead: release shard 2 measured ~5 min wall on 2026-10-22,
  // an unsharded local release run is ~2x that, and 25 min trips 15 min
  // before the 40-minute CI job cancel — naming the still-running test
  // instead of hanging silently. It never makes a test pass.
  globalTimeout: 25 * 60_000,
  outputDir: process.env.E2E_TEST_DIR ?? "test-results",
  projects: [
    // No retries: a flaky setup must fail loudly (the lane's first project),
    // never pass on a second attempt with the same email.
    { name: "setup", testMatch: /auth\.setup\.ts/u },
    // The signup-policy probe runs right after setup, before the parallel
    // bulk: it pins the policy the bootstrap account established, and later
    // specs spend invite codes and register accounts beside it.
    {
      dependencies: ["setup"],
      name: "policy",
      testMatch: /a-invite\.spec\.ts/u,
      // Same session as the bulk project (it ran there before the split).
      use: { storageState: authFile },
    },
    {
      dependencies: ["policy"],
      grep: suiteGrep,
      name: "e2e",
      testIgnore: [/a-invite\.spec\.ts/u, /auth\.setup\.ts/u],
      testMatch: /.*\.spec\.ts/u,
      // Deploy tests reuse the registered session, not the browser context.
      use: { storageState: authFile },
    },
  ],
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: process.env.E2E_REPORT_DIR ?? "playwright-report",
      },
    ],
    // Machine-readable results for the nightly flake hunt (e2e.yml's flakes
    // job reads this from the uploaded report). Local runs write it too,
    // next to the html report (the slot's own report dir on a parallel
    // lane); both are gitignored.
    [
      "json",
      {
        outputFile: `${process.env.E2E_REPORT_DIR ?? "playwright-report"}/e2e-results.json`,
      },
    ],
  ],
  shard,
  testDir: "./e2e",
  // Deploys (bun install + celld deploy + fleet boot) take minutes.
  timeout: 10 * 60_000,
  use: {
    // Bounded, so a missing element fails at its locator instead of waiting
    // out the 10-minute test deadline.
    actionTimeout: 30_000,
    baseURL,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  workers,
});
