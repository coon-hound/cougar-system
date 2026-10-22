// Phone bottom bar (usage_daily, 15 Sep - 22 Oct 2026: the ☰ menu button was
// the third most-tapped control in the app, 1,377 taps, because every view
// change on a phone cost two taps).
//
// The first bar (PR #66) passed a spec like this one and still did not work on
// phones, so these tests are a floor, not the proof: the bar must also be
// tapped on a real iPhone (Safari and home-screen app) and an Android phone
// before merge. They use tap(), not click(), and check that nothing sits over
// the centre of each tab.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const PHONE = { width: 390, height: 844 };

const activeTabs = (page) =>
  page.locator("#tabbar .nav-btn.active").evaluateAll((els) => els.map((e) => e.dataset.tab || e.id));
const activeSidebar = (page) =>
  page.locator("#sidebar .nav-btn.active").evaluateAll((els) => els.map((e) => e.dataset.nav));

test.use({ hasTouch: true, isMobile: true });

test("phone: each bar tab is one tap, nothing covers it, and both bars follow", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);

  await expect(page.locator("#tabbar")).toBeVisible();
  // The ☰ button stays as a second way in until the bar is proven on devices.
  await expect(page.locator("#mobile-nav-toggle")).toBeVisible();
  expect(await activeTabs(page)).toEqual(["dashboard"]);

  for (const [tab, heading] of [["medical", "Report Sick Log"], ["attendance", "Conduct Attendance"], ["roster", "Master Roster"], ["dashboard", "Company Strength Board"]]) {
    const sel = `#tabbar [data-tab="${tab}"]`;
    // What a finger at the centre of the tab would actually hit.
    const hit = await page.evaluate((s) => {
      const b = document.querySelector(s);
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inside: !!top && b.contains(top), h: r.height };
    }, sel);
    expect(hit.inside, `something covers the ${tab} tab`).toBe(true);
    expect(hit.h).toBeGreaterThanOrEqual(44);
    await page.tap(sel);
    await expect(page.locator("#content h2").first()).toContainText(heading);
    expect(await activeTabs(page)).toEqual([tab]);
    expect(await activeSidebar(page)).toEqual([tab]);
    await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
  }

  // The bar sits under the scroll area, not over it, and ends at the bottom.
  const geom = await page.evaluate(() => ({
    contentBottom: document.getElementById("content").getBoundingClientRect().bottom,
    barTop: document.getElementById("tabbar").getBoundingClientRect().top,
    barBottom: document.getElementById("tabbar").getBoundingClientRect().bottom,
    vh: window.innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(Math.abs(geom.contentBottom - geom.barTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geom.barBottom - geom.vh)).toBeLessThanOrEqual(1);
  expect(geom.overflow).toBeLessThanOrEqual(1);

  await page.screenshot({ path: "test-results/nav-tabbar-phone.png" });
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("phone: the bar is styled from the sidebar's own nav rows", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);
  await page.tap('#tabbar [data-tab="medical"]');
  const look = await page.evaluate(() => {
    const css = (el) => getComputedStyle(el);
    const side = document.querySelector('#sidebar .nav-btn[data-nav="medical"]');
    const tab = document.querySelector('#tabbar [data-tab="medical"]');
    const idle = document.querySelector('#tabbar [data-tab="roster"]');
    const sideIdle = document.querySelector('#sidebar .nav-btn[data-nav="roster"]');
    return {
      activeBg: [css(tab).backgroundColor, css(side).backgroundColor],
      activeInk: [css(tab).color, css(side).color],
      activeIco: [css(tab.querySelector(".nav-ico")).color, css(side.querySelector(".nav-ico")).color],
      idleInk: [css(idle).color, css(sideIdle).color],
      idleIco: [css(idle.querySelector(".nav-ico")).color, css(sideIdle.querySelector(".nav-ico")).color],
      rail: [css(tab, "::before").backgroundImage, css(side, "::before").backgroundImage],
      font: [css(tab).fontFamily, css(side).fontFamily],
      blur: css(document.getElementById("tabbar")).backdropFilter || "none",
    };
  });
  for (const [k, [tab, side]] of Object.entries(look)) {
    if (k === "blur") continue;
    expect(tab, k).toBe(side);
  }
  expect(look.blur).toBe("none");
});

test("phone: More opens the drawer and lights up for views off the bar", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);

  await page.tap("#tabbar-more");
  await expect(page.locator("#sidebar")).toHaveClass(/open/);
  await expect.poll(() => page.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().left)).toBe(0);
  await page.screenshot({ path: "test-results/nav-tabbar-drawer.png" });

  await page.tap('#sidebar .nav-btn[data-nav="ippt"]');
  await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
  await expect(page.locator("#content")).toContainText("IPPT");
  expect(await activeTabs(page)).toEqual(["tabbar-more"]);
  expect(await activeSidebar(page)).toEqual(["ippt"]);

  // Anything else that sets STATE.nav keeps both bars honest too.
  await page.evaluate(() => goToSyncTab());
  expect(await activeSidebar(page)).toEqual(["sync"]);
  expect(await activeTabs(page)).toEqual(["tabbar-more"]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("phone: the bar still works after a sheet, a search and the drawer", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);
  const d4 = await page.evaluate(() => STATE.roster.find((r) => r.role !== "Commander").id);

  await page.evaluate((id) => openPerson(id), d4);
  await page.evaluate(() => closeModal());
  await page.tap('#tabbar [data-tab="medical"]');
  await expect(page.locator("#content")).toContainText("Report Sick Log");

  await page.fill("#search-input", "a");
  await page.tap('#tabbar [data-tab="attendance"]');
  await expect(page.locator("#content")).toContainText("Conduct Attendance");
  await page.fill("#search-input", "");

  await page.tap("#tabbar-more");
  await page.tap("#sidebar-backdrop", { position: { x: 360, y: 300 } });
  await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
  await page.tap('#tabbar [data-tab="roster"]');
  await expect(page.locator("#content")).toContainText("Master Roster");
});

test("desktop: no bottom bar, sidebar as before", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedAndGoto(page);
  await expect(page.locator("#tabbar")).toBeHidden();
  await expect(page.locator("#sidebar")).toBeInViewport();
  await page.click('.nav-btn[data-nav="medical"]');
  await expect(page.locator("#content")).toContainText("Report Sick Log");
  expect(await activeSidebar(page)).toEqual(["medical"]);
});
