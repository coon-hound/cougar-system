// Feature spec for the program-aware Dashboard (PTP vs BMT). The demo fixture
// already seeds two programs, recruits across them, and attendance rows per
// program, so we drive the real dashboard: "All programs" shows the By Program
// comparison + a 2-series participation chart; picking a program focuses both.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Dashboard per-program views", () => {
  test("compare mode: By Program card + split (2-series) participation chart", async ({ page }) => {
    await seedAndGoto(page);
    const content = page.locator("#content");
    await expect(content).toContainText("By Program");
    await expect(content).toContainText("PTP");
    await expect(content).toContainText("BMT");
    // Participation chart is split into one line per program.
    const datasets = await page.evaluate(() => STATE.charts.participation.data.datasets.length);
    expect(datasets).toBe(2);
    await page.screenshot({ path: "test-results/dashboard-compare.png", fullPage: true });
  });

  test("focus mode: pick BMT -> single-series chart, By Program hidden", async ({ page }) => {
    await seedAndGoto(page);
    await page.selectOption("#filter-program", "BMT");
    const datasets = await page.evaluate(() => STATE.charts.participation.data.datasets.length);
    expect(datasets).toBe(1);
    await expect(page.locator("#content")).not.toContainText("By Program");
    // Scope banner reflects program-scoped attendance.
    await expect(page.locator("#content")).toContainText("Attendance scoped to");
    await page.screenshot({ path: "test-results/dashboard-focus-bmt.png", fullPage: true });
  });
});
