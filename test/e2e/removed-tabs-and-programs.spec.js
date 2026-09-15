// Guards the removal of Route March, SOC, Polar Flow and the PTP/BMT/Combined
// program dimension (intake 16 does not split into parallel programs).
//
// A removal needs a spec as much as a feature does: the failure mode here is a
// half-revert that leaves a nav button pointing at a deleted render function,
// which is a blank tab rather than an error anyone would notice in review.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("removed tabs and the program dimension", () => {
  test("Route March / SOC / Polar Flow tabs are gone", async ({ page }) => {
    await seedAndGoto(page);
    for (const nav of ["rm", "soc", "polar"]) {
      await expect(page.locator(`.nav-btn[data-nav="${nav}"]`)).toHaveCount(0);
    }
    // The tabs that remain still render without throwing.
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    for (const nav of ["dashboard", "roster", "attendance", "detail", "medical", "ippt", "leave", "conducts"]) {
      await page.locator(`.nav-btn[data-nav="${nav}"]`).click();
      await expect(page.locator("#content")).not.toBeEmpty();
    }
    expect(errors).toEqual([]);
  });

  test("the program filter and the platoon-to-program map are gone", async ({ page }) => {
    await seedAndGoto(page);
    await expect(page.locator("#filter-program")).toHaveCount(0);
    await page.locator('.nav-btn[data-nav="conducts"]').click();
    await expect(page.locator("#content")).not.toContainText("Training Programs");
    // Conduct usage no longer counts a Polar column.
    await expect(page.locator("#content table thead")).not.toContainText("Polar");
  });

  test("attendance shows a Scope column and no LMS", async ({ page }) => {
    await seedAndGoto(page);
    await page.locator('.nav-btn[data-nav="attendance"]').click();
    const head = page.locator("#content table thead");
    await expect(head).toContainText("Scope");
    await expect(head).not.toContainText("Program");
    await expect(head).not.toContainText("LMS");
    await expect(page.locator("#content")).not.toContainText("Recompute LMS");
    await page.screenshot({ path: "test-results/removed-tabs-attendance.png", fullPage: true });
  });

  test("the recruit profile still opens with its remaining sections", async ({ page }) => {
    // Regression guard: the Polar-metrics excision originally took openModal()
    // with it, so every recruit popup opened empty and every other spec passed.
    await seedAndGoto(page);
    await page.evaluate(() => openPerson(STATE.roster.find(r => r.role !== "Commander").id));
    const body = page.locator("#modal-body");
    await expect(body).toBeVisible();
    await expect(body).not.toBeEmpty();
    await expect(body).not.toContainText("Polar Metrics");
    await expect(body).not.toContainText("Route March");
  });
});
