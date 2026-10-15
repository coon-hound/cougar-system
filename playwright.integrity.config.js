const { defineConfig, devices } = require("@playwright/test");
const base = require("./playwright.config");

module.exports = defineConfig({
  ...base,
  testDir: "./test/integrity",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: { ...base.webServer, reuseExistingServer: false },
});
