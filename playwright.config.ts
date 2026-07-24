import { defineConfig, devices } from "@playwright/test";

// Deterministic e2e for the ranking UI. The app is a client-side feed whose
// order is produced by an on-device embedding ranker that degrades to a
// deterministic lexical ranker on any failure. The spec intercepts every RSS
// source AND the model CDN (forcing the offline lexical path), so the feed and
// its ranking are fully deterministic with no live network.
//
// Fixed port + strictPort so baseURL is stable; reuseExistingServer lets a dev
// server already on :5199 be reused. Timeouts are generous because the first
// rank still pays the cost of importing the (large) transformers.js module in
// dev before it falls back to lexical.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://localhost:5199/vibe-feed/",
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5199 --strictPort",
    url: "http://localhost:5199/vibe-feed/",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
