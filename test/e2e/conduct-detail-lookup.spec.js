// Detail tab is one conduct at a time: pick a session, see who attended and
// who didn't. Attenders are the session's scoped roster minus its detail rows.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

async function seedSession(page) {
  await page.evaluate(() => {
    STATE.attendance.push({ id: "9001", date: "28 Oct 2026", time: "0900", conductId: "c002", program: "company", total: 6, participating: 4, px: 1, fallout: 1, remarks: "" });
    STATE.conductDetail.push(
      { id: "9101", date: "28 Oct 2026", time: "0900", conductId: "c002", program: "company", d4: "1401", type: "PX", reason: "knee MC" },
      { id: "9102", date: "28 Oct 2026", time: "0900", conductId: "c002", program: "company", d4: "1402", type: "Fallout", reason: "cramp" }
    );
    render();
  });
}

test.describe("Conduct Detail: who attended a conduct", () => {
  test("opens on the newest conduct with both lists", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();

    const content = page.locator("#content");
    await expect(content.locator(".cd-session").first()).toContainText("Route March");
    await expect(content.locator("#cd-rate")).toHaveText("4 of 6 attended · 67%");
    await expect(content).toContainText("Didn't attend (2) · Status 1 · Fallout 1");
    await expect(content).toContainText("Attended (4)");
    await expect(content.locator("#cd-absent")).toContainText("knee MC");
    await expect(content.locator("#cd-absent")).toContainText("Status");
    await expect(content.locator("#cd-attended")).not.toContainText("1401");
    await expect(content.locator("#cd-attended")).toContainText("1403");
    // The old flat list of every detail row across conducts is gone.
    await expect(content).not.toContainText("All conducts (");
  });

  test("person search narrows both lists without losing focus", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();

    const box = page.locator("#cd-person-search");
    await box.pressSequentially("1402");
    await expect(box).toBeFocused();
    await expect(page.locator("#cd-people")).toContainText("Didn't attend (1 of 2)");
    await expect(page.locator("#cd-people")).toContainText("Attended (0 of 4)");
    await expect(page.locator("#cd-absent")).toContainText("cramp");
  });

  test("conduct search filters the list and a tap selects it", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();

    // The conduct's title is the picker; it opens with the search focused.
    await page.locator("#cd-pick").click();
    await expect(page.locator("#cd-session-search")).toBeFocused();
    await page.locator("#cd-session-search").fill("orientation");
    const items = page.locator("#cd-sessions .cd-session");
    await expect(items.first()).toContainText("Orientation Run");
    await expect(page.locator("#cd-sessions")).not.toContainText("Route March");
    await items.first().click();
    await expect(page.locator("#cd-title")).toContainText("Orientation Run");
    await expect(page.locator("#cd-picker")).toBeHidden();
  });

  test("‹ › step to the older and newer conduct", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();

    await expect(page.locator("#cd-title")).toContainText("Route March");
    await expect(page.getByRole("button", { name: "Newer conduct" })).toBeDisabled();
    await page.getByRole("button", { name: "Older conduct" }).click();
    await expect(page.locator("#content")).toContainText("02 Jul");
    await page.getByRole("button", { name: "Newer conduct" }).click();
    await expect(page.locator("#content")).toContainText("28 Oct 2026");
  });

  test("tapping an Attendance row opens that conduct", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="attendance"]').click();
    await page.locator("#content tbody tr", { hasText: "28 Oct 2026" }).click();

    await expect(page.locator('.nav-btn[data-nav="detail"]')).toHaveClass(/active/);
    await expect(page.locator("#content")).toContainText("Didn't attend (2)");
  });
});
