// The Roster tab's Mounted / Dismounted picker wears the same .topbar-select
// style as every other filter picker, and lights up while a filter is set.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("the mount picker is styled like the other filter pickers", async ({ page }) => {
  await seedAndGoto(page);
  await page.evaluate(() => { STATE.nav = "roster"; render(); });

  const sel = page.locator("#roster-mount");
  await expect(sel).toHaveClass(/\btopbar-select\b/);
  await expect(sel).not.toHaveClass(/\bactive\b/);

  await sel.selectOption("mounted");
  await expect(page.locator("#roster-mount")).toHaveClass(/\bactive\b/);
  // The seed has no crew, so the empty state names the filter that emptied it.
  await expect(page.locator(".empty-state")).toHaveText("No mounted personnel.");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/roster-mount-select.png", clip: { x: 190, y: 60, width: 1090, height: 160 } });
});
