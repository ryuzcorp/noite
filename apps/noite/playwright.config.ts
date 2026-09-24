import { defineConfig } from "@playwright/test";

// Raw-port lane locally (control UI direct on localhost:8090; runner API
// direct on localhost:8080; tenants on their 81xx ports). No Caddy, no
// subdomains, no /etc/hosts. Plain `localhost` (never 127.0.0.1) so the
// WebAuthn RP ID validates.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8090";

export default defineConfig({
  expect: { timeout: 30_000 },
  fullyParallel: false,
  projects: [
    // One retry: the CDP passkey ceremony flakes rarely, and a retry with
    // the same email is safe (verified: passes immediately after failing).
    { name: "setup", retries: 1, testMatch: /auth\.setup\.ts/u },
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
