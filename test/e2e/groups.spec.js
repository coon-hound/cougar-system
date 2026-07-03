const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Recruit groups", () => {
  test("assign, derive names, filter, book-out scope, rename, delete", async ({ page }) => {
    await seedAndGoto(page);
    page.on("dialog", d => d.accept());

    // A group cutting across platoons: 1401 (plt1) + 2401,2402 (plt2).
    await page.evaluate(() => setGroupMembers("Guard Duty", ["1401", "2401", "2402"]));

    // Names derive from membership; members query works; commanders never join.
    const model = await page.evaluate(() => ({
      names: allGroupNames(),
      members: groupMembers("Guard Duty").map(r => r.id).sort(),
      tag1401: STATE.roster.find(r => r.id === "1401").groups,
    }));
    expect(model.names).toEqual(["Guard Duty"]);
    expect(model.members).toEqual(["1401", "2401", "2402"]);
    expect(model.tag1401).toBe("Guard Duty");

    // Topbar group filter appears and narrows the roster to members.
    await page.click(`.nav-btn[data-nav="roster"]`);
    const opts = await page.$$eval("#filter-group option", els => els.map(e => e.textContent));
    expect(opts.some(o => /Guard Duty/.test(o))).toBe(true);
    await page.selectOption("#filter-group", "Guard Duty");
    await page.waitForTimeout(150);
    const shown = await page.$$eval("table tbody tr td:first-child", tds => tds.map(t => t.textContent.trim()).filter(Boolean));
    expect(shown.sort()).toEqual(["1401", "2401", "2402"]);

    // filteredRoster + filterLabel reflect the group scope.
    const scope = await page.evaluate(() => ({ n: filteredRoster().length, label: filterLabel() }));
    expect(scope.n).toBe(3);
    expect(scope.label).toContain("Guard Duty");

    // Book-out scope: a "grp:" option targets exactly the in-camp members.
    const targets = await page.evaluate(() => bookOutTargets("grp:Guard Duty").map(r => r.id).sort());
    expect(targets).toEqual(["1401", "2401", "2402"]);
    await page.evaluate(() => bookOutMany(bookOutTargets("grp:Guard Duty").map(r => r.id), "Guard mounting"));
    const out = await page.evaluate(() => [...outOfCampMap(todayISO()).keys()].sort());
    expect(out).toEqual(["1401", "2401", "2402"]);

    // Rename follows members; delete dissolves the group and clears the filter.
    await page.evaluate(() => renameGroup("Guard Duty", "Guard"));
    expect(await page.evaluate(() => allGroupNames())).toEqual(["Guard"]);
    await page.evaluate(() => { STATE.filterGroup = "Guard"; deleteGroup("Guard"); });
    const after = await page.evaluate(() => ({ names: allGroupNames(), filter: STATE.filterGroup }));
    expect(after.names).toEqual([]);
    expect(after.filter).toBe("");
  });
});
