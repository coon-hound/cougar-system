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
const crypto = require("crypto");
const { defineConfig, devices } = require("@playwright/test");

// The default port is derived from THIS checkout's path, because
// `reuseExistingServer` will happily adopt a server someone else already
// started - and with one fixed port that meant a worktree's run could be served
// the MAIN checkout's files and pass against code it never contains. Every
// worktree now gets its own port, and the server is pinned to this directory
// with --directory so it cannot serve another tree either way. PW_PORT still
// overrides.
const pathPort = 5500 + (parseInt(crypto.createHash("sha1").update(__dirname).digest("hex").slice(0, 6), 16) % 400);
const PORT = process.env.PW_PORT ? Number(process.env.PW_PORT) : pathPort;

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
    command: `python3 -m http.server ${PORT} --directory ${__dirname}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
