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
const workers = Number(process.env.E2E_WORKERS ?? 3);

export default defineConfig({
  expect: { timeout: 30_000 },
  fullyParallel: false,
  projects: [
    // One retry: the CDP passkey ceremony flakes rarely, and a retry with
    // the same email is safe (verified: passes immediately after failing).
    { name: "setup", retries: 1, testMatch: /auth\.setup\.ts/u },
    // The signup-policy probe runs right after setup, before the parallel
    // bulk: it pins the policy the bootstrap account established, and later
    // specs spend invite codes and register accounts beside it.
    {
      dependencies: ["setup"],
      name: "policy",
      testMatch: /a-invite\.spec\.ts/u,
      // Same session as the bulk project (it ran there before the split).
      use: { storageState: "e2e/.auth/user.json" },
    },
    {
      dependencies: ["policy"],
      name: "e2e",
      testIgnore: [/a-invite\.spec\.ts/u, /auth\.setup\.ts/u],
      testMatch: /.*\.spec\.ts/u,
      // Deploy tests reuse the registered session, not the browser context.
      use: { storageState: "e2e/.auth/user.json" },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
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
