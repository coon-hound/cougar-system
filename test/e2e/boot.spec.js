// Boot smoke — the master-safe baseline spec that proves the Playwright harness
// works end to end: the REAL site loads, seeds from localStorage with no network,
// and renders. It asserts nothing feature-specific, so it stays green on plain
// master; feature specs (e.g. training-programs.spec.js) build on top of it.
const { test, expect } = require("@playwright/test");
const { seedAndGoto, SEED } = require("./support");

test("app boots from seeded cache with no backend and renders", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await seedAndGoto(page);

  // The seeded roster is loaded into STATE (7 people: 6 recruits + 1 commander).
  const rosterCount = await page.evaluate(() => STATE.roster.length);
  expect(rosterCount).toBe(SEED["cougar-data-v2"].roster.length);

  // No unhandled exceptions during boot/render.
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);

  // The main app shell rendered (nav + content mount exist).
  await expect(page.locator("#content")).toBeVisible();

  await page.screenshot({ path: "test-results/boot.png", fullPage: true });
});
