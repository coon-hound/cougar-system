// The dashboard puts what people reach for first (usage_daily, Sep 2026).
//
//  · The due parade state is one tap. It took two every time (200 menu opens,
//    167 report opens), and which one is due is a matter of the clock.
//  · The three most-opened forms (Book Out 97, Report Sick 77, Log Conduct 43)
//    are one tap from the landing view.
//  · "Re-push all" - a full-table rewrite that can clobber another phone's edit
//    - leaves seven view headers for one repair card in Sync & I/O.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const PHONE = { width: 390, height: 844 };

for (const [hour, label, modal] of [[9, "First Parade", "First Parade State"], [18, "Last Parade", "Last Parade State"]]) {
  test(`at ${hour}:00 the report button opens the ${label} in one tap`, async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    // Local wall-clock time: the browser runs in the same zone as the runner.
    await page.clock.setFixedTime(new Date(2026, 9, 1, hour, 0, 0));
    await seedAndGoto(page);

    const main = page.locator("#content .split-btn > .btn").first();
    await expect(main).toHaveText(label);
    await main.click();
    await expect(page.locator("#modal-overlay")).toBeVisible();
    await expect(page.locator("#modal-overlay")).toContainText(modal);
    // The menu never had to open.
    await expect(page.locator("#report-menu")).toBeHidden();
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  });
}

test("the full report menu is behind the caret, Compare set apart at the bottom", async ({ page }) => {
  await seedAndGoto(page);
  await page.locator("#content .split-caret").click();
  const menu = page.locator("#report-menu");
  await expect(menu).toBeVisible();
  const order = await menu.locator(":scope > *").evaluateAll((els) =>
    els.map((e) => (e.classList.contains("dropdown-sep") ? "---" : e.textContent.trim())));
  expect(order).toEqual([
    "◱First Parade State", "◳Last Parade State", "✚Medical Status List",
    "⊕MSK Report", "▤Per-Conduct Chat Format", "---", "⇄Compare Parade States"
  ]);
});

test("phone: quick actions open the three most-used forms in one tap", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize(PHONE);
  await seedAndGoto(page);

  const acts = page.locator("#content .quick-act");
  await expect(acts).toHaveText(["✚Report Sick", "↗Book Out", "▤Log Conduct"]);
  // Three across, all on one row, none overflowing a 390px phone.
  const boxes = await acts.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ y: Math.round(r.y), w: r.width })));
  expect(new Set(boxes.map((b) => b.y)).size).toBe(1);
  expect(boxes.every((b) => b.w >= 100)).toBe(true);
  // The header row did not wrap the split button off the right edge.
  const split = await page.locator("#content .split-btn").evaluate((e) => e.getBoundingClientRect().right);
  expect(split).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/dashboard-actions-phone.png" });

  await acts.nth(0).click();
  await expect(page.locator("#modal-overlay #f-d4")).toBeVisible();
  await page.evaluate(() => closeModal());

  await acts.nth(1).click();
  await expect(page.locator("#modal-overlay")).toContainText(/Book Out/i);
  await page.evaluate(() => closeModal());

  await acts.nth(2).click();
  await expect(page.locator("#modal-overlay")).toBeVisible();
  await page.evaluate(() => closeModal());
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("Re-push lives in Sync & I/O, not beside each view's main action", async ({ page }) => {
  await seedAndGoto(page);
  for (const nav of ["roster", "attendance", "detail", "medical", "ippt", "leave", "conducts"]) {
    await page.evaluate((n) => goNav(n), nav);
    await expect(page.locator("#content")).not.toContainText("Re-push all");
  }
  await page.evaluate(() => goNav("sync"));
  const repush = page.locator('#content [data-tel^="repush:"]');
  await expect(repush).toHaveText(["Roster", "Medical", "Attendance", "Detail", "IPPT", "Leave", "Conducts"]);
  await page.screenshot({ path: "test-results/dashboard-actions-sync.png", fullPage: true });
});
