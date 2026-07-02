// Playwright config — the repo's only dev-dependency, test-only. It drives the
// REAL frontend (index.html + js/*.js) in a headless Chromium against seeded
// demo data, so a frontend feature is exercised in a real DOM before it ships.
// Nothing here is served to users; node_modules/ is git-ignored and never
// deployed to GitHub Pages.
//
// The app renders purely from localStorage when STATE.authToken is empty (see
// js/main.js bootstrap + js/state.js loadLocal), so specs seed localStorage via
// test/e2e/support.js and never touch the network — deterministic and offline,
// mirroring the node harness's mock-fetch approach.
const { defineConfig, devices } = require("@playwright/test");

const PORT = process.env.PW_PORT ? Number(process.env.PW_PORT) : 5599;

module.exports = defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.js/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // A dependency-free static server for the repo root. python3 ships on macOS
  // and ubuntu-latest (CI), so this needs no extra install.
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
