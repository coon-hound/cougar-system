// Navigation, shaped by what people actually open (usage_daily, Sep 2026).
//
// On a phone the sidebar is a drawer, and reaching it cost a tap on almost
// every view switch (516 hamburger taps against ~570 nav taps). The four views
// behind ~90% of navigation now sit on a bottom bar, one tap from anywhere;
// More opens the drawer for the rest. MSK Analytics folds into Medical as a
// sub-tab, and the sync pill opens Sync & I/O.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const PHONE = { width: 390, height: 844 };

const activeTab = (page) =>
  page.locator("#tabbar .tab-btn.active").evaluateAll((els) => els.map((e) => e.dataset.nav || e.id));
const activeSidebar = (page) =>
  page.locator("#sidebar .nav-btn.active").evaluateAll((els) => els.map((e) => e.dataset.nav));

test("phone: the bottom bar reaches the daily views in one tap", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);

  await expect(page.locator("#tabbar")).toBeVisible();
  await expect(page.locator("#sidebar")).not.toBeInViewport();
  expect(await activeTab(page)).toEqual(["dashboard"]);

  for (const [nav, heading] of [["medical", "Report Sick Log"], ["attendance", "Attendance"], ["roster", "Roster"], ["dashboard", "Company Strength Board"]]) {
    await page.click(`#tabbar [data-nav="${nav}"]`);
    await expect(page.locator("#content")).toContainText(heading);
    expect(await activeTab(page)).toEqual([nav]);
    // The drawer never opened, and the sidebar highlight followed anyway.
    await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
    expect(await activeSidebar(page)).toEqual([nav]);
  }

  // The bar sits below the scroll area, not over it: the last pixel of
  // #content ends where the bar begins.
  const geom = await page.evaluate(() => ({
    contentBottom: document.getElementById("content").getBoundingClientRect().bottom,
    barTop: document.getElementById("tabbar").getBoundingClientRect().top,
    barBottom: document.getElementById("tabbar").getBoundingClientRect().bottom,
    vh: window.innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));
  expect(Math.abs(geom.contentBottom - geom.barTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geom.barBottom - geom.vh)).toBeLessThanOrEqual(1);
  expect(geom.overflow).toBeLessThanOrEqual(1);

  await page.screenshot({ path: "test-results/nav-tabbar-phone.png" });
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("phone: More opens the grouped drawer, and lights up for views off the bar", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);

  await page.click("#tabbar-more");
  await expect(page.locator("#sidebar")).toHaveClass(/open/);
  await expect.poll(() => page.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().left)).toBe(0);
  await expect(page.locator("#sidebar .nav-group")).toHaveText(["Daily", "Records", "System"]);
  // MSK Analytics is no longer a sidebar destination of its own.
  await expect(page.locator('.nav-btn[data-nav="mskAnalytics"]')).toHaveCount(0);
  await page.screenshot({ path: "test-results/nav-tabbar-drawer.png" });

  await page.click('.nav-btn[data-nav="ippt"]');
  await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
  await expect(page.locator("#content")).toContainText("IPPT");
  expect(await activeTab(page)).toEqual(["tabbar-more"]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("MSK Analytics is a sub-tab of Medical", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);

  await page.click('#tabbar [data-nav="medical"]');
  const seg = page.locator('#content .seg[aria-label="Medical views"]');
  await expect(seg.locator('[aria-selected="true"]')).toHaveText("Report Sick Log");

  await seg.getByText("MSK Analytics").click();
  await expect(page.locator("#content")).toContainText("Musculoskeletal injuries");
  await expect(page.locator('#content .seg [aria-selected="true"]')).toHaveText("MSK Analytics");
  // Still "in" Medical as far as both bars are concerned.
  expect(await activeTab(page)).toEqual(["medical"]);
  expect(await activeSidebar(page)).toEqual(["medical"]);
  await page.screenshot({ path: "test-results/nav-tabbar-msk.png" });

  await page.locator("#content .seg").getByText("Report Sick Log").click();
  await expect(page.locator("#content")).toContainText("Report Sick Log");
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("the sync pill opens Sync & I/O when there is nothing to retry", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);
  // Offline, so the pill is not in its error state: a tap navigates.
  await page.evaluate(() => updateSyncPill("ok", "✓ Saved"));
  await page.click("#sync-status");
  await expect(page.locator("#content")).toContainText("Sync & Import / Export");
  expect(await activeTab(page)).toEqual(["tabbar-more"]);

  // In the error state the same tap is still a retry, not a navigation.
  let retried = false;
  await page.exposeFunction("__retried", () => { retried = true; });
  await page.click('#tabbar [data-nav="dashboard"]');
  await page.evaluate(() => updateSyncPill("error", "⚠ Sync error", () => window.__retried()));
  await page.click("#sync-status");
  await expect.poll(() => retried).toBe(true);
  await expect(page.locator("#content")).toContainText("Company Strength Board");
});

test("desktop: no bottom bar, grouped sidebar always visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedAndGoto(page);
  await expect(page.locator("#tabbar")).toBeHidden();
  await expect(page.locator("#sidebar")).toBeInViewport();
  await expect(page.locator("#sidebar .nav-group")).toHaveText(["Daily", "Records", "System"]);
  await page.click('.nav-btn[data-nav="medical"]');
  await expect(page.locator("#content")).toContainText("Report Sick Log");
  await page.screenshot({ path: "test-results/nav-tabbar-desktop.png" });
});

test("phone: search keeps its width, and results drop down with 4D and name", async ({ page }) => {
  // On master the empty results container took flex-basis:100% inside the
  // one-row topbar: the field was 77px wide and five hits stacked three rows
  // deep beside it, showing only 4Ds.
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);

  const fieldWidth = () => page.evaluate(() => document.getElementById("search-input").getBoundingClientRect().width);
  expect(await fieldWidth()).toBeGreaterThan(200);
  const barHeight = await page.evaluate(() => document.getElementById("topbar").getBoundingClientRect().height);

  await page.fill("#search-input", "1");
  const hits = page.locator("#search-results .search-hit");
  await expect(hits.first()).toBeVisible();
  // One hit per row, full width, under the bar - and the bar did not grow.
  const rows = await hits.evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), y: Math.round(r.y) };
  }));
  expect(rows.length).toBeGreaterThan(1);
  expect(new Set(rows.map((r) => r.y)).size).toBe(rows.length);
  expect(rows.every((r) => r.w > 300)).toBe(true);
  expect(await page.evaluate(() => document.getElementById("topbar").getBoundingClientRect().height)).toBe(barHeight);
  expect(await fieldWidth()).toBeGreaterThan(200);
  // Says who, not just which seat.
  await expect(hits.first()).toContainText(/\d{4}\s*\S+/);
  await page.waitForTimeout(300); // let the drop-down settle for the screenshot
  await page.screenshot({ path: "test-results/nav-tabbar-search.png" });

  // A name search finds by name and opens the person; the dropdown clears.
  await page.fill("#search-input", "alpha one");
  await expect(hits).toHaveCount(1);
  await hits.first().click();
  await expect(page.locator("#modal-overlay")).not.toHaveClass(/hidden/);
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect(page.locator("#search-results")).toBeEmpty();
  await page.evaluate(() => closeModal());

  await page.fill("#search-input", "zzzz");
  await expect(page.locator("#search-results")).toContainText("No match");
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
