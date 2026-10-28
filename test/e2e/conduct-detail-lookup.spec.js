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

  test("conduct search takes dates the way people type them", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();
    await page.locator("#cd-pick").click();
    for (const q of ["28/10", "28/10/26", "2810", "2026-10-28", "route 28 oct"]) {
      await page.locator("#cd-session-search").fill(q);
      await expect(page.locator("#cd-sessions .cd-session"), q).toHaveCount(1);
    }
  });

  test("attenders are grouped by platoon with each platoon's turnout", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();
    // 1401/1402 are out, so platoon 1 has 1 of 3; platoon 2 all 3.
    await expect(page.locator("#cd-attended")).toContainText("Platoon 1 · 1 of 3");
    await expect(page.locator("#cd-attended")).toContainText("Platoon 2 · 3 of 3");
  });

  test("with no conducts logged, the first action is right there", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => { STATE.attendance = []; STATE.conductDetail = []; STATE.nav = "detail"; render(); });
    await expect(page.locator("#content")).toContainText("No conducts logged yet.");
    await page.locator("#content").getByRole("button", { name: "+ Log Conduct" }).click();
    await expect(page.locator("#modal-overlay")).toBeVisible();
  });

  test("on a phone the platoon groups start folded and a search opens them", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAndGoto(page);
    await seedSession(page);
    await page.evaluate(() => { STATE.nav = "detail"; render(); });
    const groups = page.locator("#cd-attended details");
    await expect(groups.first()).not.toHaveAttribute("open", "");
    await expect(page.locator("#cd-attended")).toContainText("Platoon 2 · 3 of 3");
    await page.locator("#cd-person-search").fill("bravo");
    await expect(page.locator("#cd-attended details").first()).toHaveAttribute("open", "");
  });

  test("the copied name list carries both lists, absentees with reasons", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();
    const [all, absentOnly] = await page.evaluate(() => {
      const s = cdSessions().find(x => x.key === _cdSel);
      return [cdNameListText(s, "all"), cdNameListText(s, "absent")];
    });
    expect(all).toContain("ROUTE MARCH, 28 OCT 2026 0900 HRS");
    expect(all).toContain("Attended: 4/6");
    expect(all).toContain("DIDN'T ATTEND (2)\nStatus (1)\n1. 1401 ALPHA ONE - knee MC\nFallout (1)\n1. 1402 ALPHA TWO - cramp");
    expect(all).toContain("ATTENDED (4)\nPlatoon 1 (1)\n1. 1403 ALPHA THREE\nPlatoon 2 (3)");
    expect(absentOnly).toContain("DIDN'T ATTEND (2)");
    expect(absentOnly).not.toContain("ATTENDED (4)");
  });

  test("CSV exports: this conduct, and every conduct as a grid", async ({ page }) => {
    await seedAndGoto(page);
    await seedSession(page);
    await page.locator('.nav-btn[data-nav="detail"]').click();
    const readDownload = async label => {
      await page.locator("#cd-export-btn").click();
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: label }).click()]);
      const fs = require("fs");
      return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), "utf8") };
    };
    const one = await readDownload("Download this conduct (CSV)");
    expect(one.name).toMatch(/^attendance-route-march-28-oct-2026-0900-hrs\.csv$/);
    expect(one.text).toContain("4D,Name,Platoon,Section,Attended,Type,Reason");
    expect(one.text).toContain("1401,ALPHA ONE,1,4,No,Status,knee MC");
    expect(one.text).toContain("1403,ALPHA THREE,1,4,Yes,,");
    const grid = await readDownload("Download all conducts as a grid (CSV)");
    const [head, ...rows] = grid.text.trim().split(/\r?\n/);
    expect(head).toContain("28 Oct 2026 0900 Route March");
    expect(head.endsWith(",Missed")).toBe(true);
    expect(rows.find(r => r.startsWith("1402,"))).toContain("Fallout");
    expect(rows.find(r => r.startsWith("1403,"))).toContain("Present");
  });
});
