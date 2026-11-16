import { defineConfig } from "@playwright/test";

// The upgrade lane's specs (`sh docker/e2e-upgrade.sh`): seed the previous
// release's image, restart on the tree image, verify the seed survived.
// Separate from `playwright.config.ts` (whose `e2e` project would otherwise
// run these against the wrong stack, in the wrong phase): this config runs
// one file per phase — `seed.spec.ts` against the old image, `verify.spec.ts`
// against the new one — with the same environment knobs as the e2e lane
// (E2E_BASE_URL, E2E_API_BASE, E2E_AUTH_DIR, E2E_REPORT_DIR, E2E_TEST_DIR).
const authFile = process.env.E2E_AUTH_DIR
  ? `${process.env.E2E_AUTH_DIR}/user.json`
  : "upgrade/.auth/user.json";

export default defineConfig({
  expect: { timeout: 30_000 },
  fullyParallel: false,
  globalTimeout: 20 * 60_000,
  outputDir: process.env.E2E_TEST_DIR ?? "test-results-upgrade",
  projects: [
    // No retries: a flaky setup must fail loudly, never pass on a second
    // attempt with the same email.
    { name: "setup", testMatch: /auth\.setup\.ts/u },
    {
      dependencies: ["setup"],
      name: "upgrade",
      testIgnore: /auth\.setup\.ts/u,
      testMatch: /.*\.spec\.ts/u,
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
  ],
  testDir: "./upgrade",
  // A seed deploys the sample app (bun install + celld deploy + fleet boot).
  timeout: 10 * 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://noite.localhost:8090",
  },
});
