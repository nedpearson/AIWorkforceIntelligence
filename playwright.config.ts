import { defineConfig, devices } from "@playwright/test";

/**
 * BridgeBox end-to-end acceptance suite.
 *  - `setup` logs in once per role and stores cookies under tests/e2e/.auth/.
 *  - `desktop` runs every spec at 1280×800; `mobile` runs only the `@mobile`-tagged subset on a Pixel 5.
 *  - Specs mutate a shared Postgres, so they run serially (workers: 1). Each spec creates what it needs with
 *    unique names and never deletes seeded rows, which keeps the suite re-runnable without `npm run db:reset`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    // The demo organizations live in America/Chicago; run the browser there so date pickers behave as a real client would see them.
    timezoneId: process.env.E2E_TZ ?? "America/Chicago",
    navigationTimeout: 45_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      grepInvert: /@mobile/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      grep: /@mobile/,
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    port: 3000,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
