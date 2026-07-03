// Feature spec for Training Programs UI — drives the REAL frontend in a browser
// against the seeded demo data (PTP=plt1, BMT=plt2, plus a Combined session).
// Proves the topbar program filter narrows the attendance table, program badges
// render, and the Conducts tab exposes the program→platoon assignment card.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Training Programs", () => {
  test("program filter narrows the attendance table and shows badges", async ({ page }) => {
    await seedAndGoto(page);

    // Topbar program filter exists and lists the seeded programs + Combined.
    const sel = page.locator("#filter-program");
    await expect(sel).toBeVisible();
    await expect(sel.locator("option")).toContainText(["All programs", "PTP", "BMT", "Combined"]);

    // Attendance tab: all three seeded sessions (PTP, BMT, Combined) are shown.
    await page.locator('.nav-btn[data-nav="attendance"]').click();
    const rows = page.locator("#content table tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(page.locator("#content")).toContainText("PTP");
    await expect(page.locator("#content")).toContainText("BMT");

    // Scope to PTP → only the PTP session survives the filter.
    await sel.selectOption("PTP");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("PTP");
    await expect(page.locator("#content table tbody")).not.toContainText("BMT");

    await page.screenshot({ path: "test-results/training-programs-filter.png", fullPage: true });
  });

  test("Conducts tab shows the program→platoon assignment card", async ({ page }) => {
    await seedAndGoto(page);
    await page.locator('.nav-btn[data-nav="conducts"]').click();

    // The assignment card and both seeded programs are present, with platoon
    // checkboxes to (un)assign a platoon to a program.
    await expect(page.locator("#content")).toContainText("Training Programs");
    await expect(page.locator("#content")).toContainText("PTP");
    await expect(page.locator("#content")).toContainText("BMT");
    await expect(page.locator('#content input[type="checkbox"]').first()).toBeVisible();
  });
});
