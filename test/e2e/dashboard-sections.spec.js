// Dashboard progressive disclosure — the strength tiles stay as the always-
// visible hero and every section below collapses to a one-line summary card
// (count in the title + colored breakdown chips). These tests prove:
// collapsed-by-default, expand/collapse in place, summary chips update
// without expanding, stat tiles act as shortcuts, open state survives tab
// switches + reloads, charts only build while Trends is open, and the header
// action buttons still work from a collapsed row.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("dashboard sections", () => {
  test("boots collapsed: hero tiles + one-line summaries, no bodies", async ({ page }) => {
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await seedAndGoto(page);

    // Hero: the 6 strength tiles.
    await expect(page.locator(".stats-row .stat")).toHaveCount(6);

    // Sections render collapsed. The fixture has no MSK rows, so that
    // section is hidden entirely (6 of the 7 sections).
    await expect(page.locator(".dash-sec")).toHaveCount(6);
    await expect(page.locator(".dash-sec-body")).toHaveCount(0);

    // The closed row is itself the report: count in the title, state note.
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-title")).toContainText("Out of Camp (0)");
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-summary")).toContainText("everyone in camp");

    expect(errs, errs.join("\n")).toEqual([]);
    await page.screenshot({ path: "test-results/dashboard-collapsed.png", fullPage: true });
  });

  test("a section expands in place and collapses again", async ({ page }) => {
    await seedAndGoto(page);
    const toggle = page.locator("#dash-sec-outofcamp .dash-sec-toggle");

    await toggle.click();
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-body")).toBeVisible();
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-body")).toContainText("Everyone in scope is in camp");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await toggle.click();
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-body")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("summary chips update without expanding; the body shows the row", async ({ page }) => {
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await seedAndGoto(page);

    // Book someone out — the closed header must already tell the story.
    await page.evaluate(() => bookOutToggle(STATE.roster[0].id, true, "Errand"));
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-title")).toContainText("Out of Camp (1)");
    await expect(page.locator("#dash-sec-outofcamp .dash-chip")).toContainText("1 booked out");

    // Expanding shows the person with the one-tap Book in undo.
    await page.click("#dash-sec-outofcamp .dash-sec-toggle");
    const body = page.locator("#dash-sec-outofcamp .dash-sec-body");
    await expect(body).toContainText("Errand");
    await expect(body.getByText("↩ Book in")).toBeVisible();

    // Booking back in from inside the section keeps it open (no jump/reset).
    await body.getByText("↩ Book in").click();
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-title")).toContainText("Out of Camp (0)");
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-body")).toBeVisible();

    expect(errs, errs.join("\n")).toEqual([]);
  });

  test("a stat tile is a shortcut that opens its section", async ({ page }) => {
    await seedAndGoto(page);
    await page.click('.stat-link:has-text("Out of Camp")');
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-body")).toBeVisible();
    await page.click('.stat-link:has-text("Non-Active")');
    await expect(page.locator("#dash-sec-medical .dash-sec-body")).toBeVisible();
  });

  test("open state survives tab switches and reloads", async ({ page }) => {
    await seedAndGoto(page);
    await page.click("#dash-sec-trends .dash-sec-toggle");
    await expect(page.locator("#dash-sec-trends .dash-sec-body")).toBeVisible();

    await page.click('.nav-btn[data-nav="roster"]');
    await page.click('.nav-btn[data-nav="dashboard"]');
    await expect(page.locator("#dash-sec-trends .dash-sec-body")).toBeVisible();

    // Reload: persisted via localStorage (cougar-dash-open), not just memory.
    await page.reload();
    await page.waitForFunction(() => typeof STATE !== "undefined" && Array.isArray(STATE.roster) && STATE.roster.length > 0);
    await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
    await expect(page.locator("#dash-sec-trends .dash-sec-body")).toBeVisible();
  });

  test("charts exist only while Trends is open (offline-safe)", async ({ page }) => {
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await seedAndGoto(page);

    await expect(page.locator("#chart-status")).toHaveCount(0);
    await page.click("#dash-sec-trends .dash-sec-toggle");
    // Assert on chart-adjacent DOM, never canvas contents (CDN may be absent).
    await expect(page.locator("#dash-sec-trends h3", { hasText: "Status Breakdown" })).toBeVisible();
    await expect(page.locator("#dash-sec-trends h3", { hasText: "Participation Trend" })).toBeVisible();
    await expect(page.locator("#chart-status")).toHaveCount(1);
    expect(errs, errs.join("\n")).toEqual([]);
  });

  test("appointment 🚪 Out button books the person out (regression: onclick quoting)", async ({ page }) => {
    // The old markup interpolated JSON.stringify(...) straight into a
    // double-quoted onclick, so the first emitted `"` truncated the attribute
    // and the button was dead. Now it goes through escapeAttr. A reason with
    // embedded double quotes is the worst case — it must still work.
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.appointments.push({
        id: 920001, d4: STATE.roster[0].id, date: isoToDisplayDate(todayISO()), time: "14:30",
        reason: 'Physio "review"', location: "Physio Centre", outOfCamp: true, resolved: false,
      });
      saveLocal(); render();
    });
    await page.click("#dash-sec-appointments .dash-sec-toggle");
    await page.click('#dash-sec-appointments .dash-sec-body >> text=🚪 Out');

    await expect(page.locator("#dash-sec-outofcamp .dash-chip")).toContainText("1 booked out");
    const reason = await page.evaluate(() => outOfCampMap(todayISO()).get(STATE.roster[0].id)?.reason);
    expect(reason).toContain('Appt: Physio "review"');
    expect(errs, errs.join("\n")).toEqual([]);
  });

  test("+ Book Out opens the unified modal from a collapsed header", async ({ page }) => {
    await seedAndGoto(page);
    await page.click("text=+ Book Out");
    await expect(page.locator("#f-bo-scope")).toBeVisible();
    // Opening the modal must not have toggled the section underneath.
    await expect(page.locator("#dash-sec-outofcamp .dash-sec-body")).toHaveCount(0);
  });
});

test.describe("dashboard on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("collapsed dashboard fits without horizontal scroll; headers are thumb-sized", async ({ page }) => {
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await seedAndGoto(page);

    const overflow = await page.evaluate(() => {
      const c = document.getElementById("content");
      return c.scrollWidth - c.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);

    const h = await page
      .locator("#dash-sec-outofcamp .dash-sec-toggle")
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(44);

    expect(errs, errs.join("\n")).toEqual([]);
    await page.screenshot({ path: "test-results/dashboard-mobile.png", fullPage: true });
  });
});
