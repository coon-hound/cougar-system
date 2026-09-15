// Dashboard (Company Strength Board) — the screen a commander opens standing
// outside: six stat tiles, then one collapsible card per "who is not here and
// why", then the charts. These specs pin the things that broke before:
//   * the stat tiles being the headline (six of them, breakdown as a footnote)
//   * every block living in a .card rather than floating as a bare heading
//   * the Generate Report dropdown being CLICKABLE, not merely present — an
//     identity-matrix stacking context once trapped it behind the stat tiles,
//     and "the element exists" would not have caught that
//   * both branches of the empty-roster guard (mid-pull vs never-authenticated)
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("dashboard renders six stat tiles with the R/C split as a footnote", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await seedAndGoto(page);

  const tiles = page.locator("#content .stats-row .stat");
  await expect(tiles).toHaveCount(6);
  for (const label of ["Total Str", "In Camp", "Out of Camp", "Active today", "Non-Active", "Avg Part."]) {
    await expect(page.locator("#content .stats-row .stat label", { hasText: label })).toHaveCount(1);
  }
  // The headline number is .val; the recruit/commander breakdown is .sub and
  // must be visibly smaller than it, not a second headline.
  const sizes = await page.evaluate(() => {
    const t = document.querySelector("#content .stats-row .stat");
    return {
      val: parseFloat(getComputedStyle(t.querySelector(".val")).fontSize),
      sub: parseFloat(getComputedStyle(t.querySelector(".sub")).fontSize),
    };
  });
  expect(sizes.sub).toBeLessThan(sizes.val / 2);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  await page.screenshot({ path: "test-results/dashboard.png", fullPage: true });
});

test("every dashboard section is a card, and sections collapse and expand", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await seedAndGoto(page);

  // Out of Camp is a .card and a DIRECT child of #content (one step of the
  // page-enter stagger), not a bare heading floating on the page ground.
  const out = page.locator("#content > #dash-outofcamp");
  await expect(out).toBeVisible();
  await expect(out).toHaveClass(/card/);
  await expect(out.locator("button", { hasText: "Book Out" })).toBeVisible();

  // Appointments likewise, and its body is open by default only when there is
  // something in it. Toggling the header hides/shows the body in place.
  const appts = page.locator("#content > #dash-appointments");
  await expect(appts).toHaveClass(/card/);
  const toggle = appts.locator('button[aria-expanded]').first();
  const before = await toggle.getAttribute("aria-expanded");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");
  await expect(appts.locator("#dash-appointments-body")).toHaveCount(before === "true" ? 0 : 1);

  // The charts are inside a fixed-height .chart-box — the defect this screen
  // was rebuilt for was a doughnut growing to ~500px.
  const trends = page.locator("#content > #dash-trends");
  await expect(trends).toBeVisible();
  const boxHeight = await trends.locator(".chart-box").first().evaluate(el => el.getBoundingClientRect().height);
  expect(boxHeight).toBeGreaterThan(0);
  expect(boxHeight).toBeLessThanOrEqual(260);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("the Generate Report dropdown opens and its items are actually clickable", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await seedAndGoto(page);

  const menu = page.locator("#report-menu");
  await expect(menu).toBeHidden();
  await page.locator("#content button", { hasText: "Generate Report" }).click();
  await expect(menu).toBeVisible();

  // The regression this guards: the menu painted BEHIND the stat tiles, so the
  // element existed and was "visible" but the click landed on a tile. A real
  // click (no force) fails if anything covers it — and the modal proves the
  // handler ran.
  await menu.locator("button", { hasText: "First Parade State" }).click();
  await expect(page.locator("#modal-overlay")).toBeVisible();
  await expect(page.locator("#modal-overlay")).toContainText("First Parade State");

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("the empty-roster guard keeps both paths: mid-pull and never-authenticated", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await seedAndGoto(page);

  // Never-authenticated: no invite redeemed on this device.
  await page.evaluate(() => { STATE.roster = []; STATE.authToken = ""; render(); });
  await expect(page.locator("#content .empty-state")).toContainText("No invite redeemed");
  await expect(page.locator("#content h2")).toContainText("Company Strength Board");

  // Authenticated but empty: mid-pull, with a retry.
  await page.evaluate(() => { STATE.authToken = "fake-token"; render(); });
  await expect(page.locator("#content .empty-state")).toContainText("Loading data");
  await expect(page.locator("#content .empty-state button", { hasText: "Retry now" })).toBeVisible();

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
