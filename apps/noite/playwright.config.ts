import { defineConfig } from "@playwright/test";

// Prod edge locally (plain HTTP; TLS only fronts real domains). Subdomain
// hosts (api./git./{slug}.localhost) need /etc/hosts entries — `make e2e`
// checks them (docker/e2e-local.sh).
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:9080";

export default defineConfig({
  expect: { timeout: 30_000 },
  fullyParallel: false,
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/u },
    {
      dependencies: ["setup"],
      name: "e2e",
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
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  workers: 1,
});
