const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Combined groups (set formulas)", () => {
  test("resolve include/exclude, filter and book-out scope", async ({ page }) => {
    await seedAndGoto(page);
    page.on("dialog", d => d.accept());

    // Seed: plt1 = 1401/1402/1403, plt2 = 2401/2402/2403. Guard Duty spans both.
    await page.evaluate(() => {
      setGroupMembers("Guard Duty", ["1401", "2401"]);
      STATE.combinedGroups = [
        { name: "P1 − Guard", include: ["plt:1"], exclude: ["grp:Guard Duty"] },
        { name: "P1+P2 − Guard", include: ["plt:1", "plt:2"], exclude: ["grp:Guard Duty"] },
      ];
      saveCombinedGroups();
    });

    // Resolution: union of includes minus excludes.
    const r = await page.evaluate(() => ({
      a: [...combinedMemberSet("P1 − Guard")].sort(),
      b: [...combinedMemberSet("P1+P2 − Guard")].sort(),
      formula: combinedFormula(combinedByName("P1+P2 − Guard")),
    }));
    expect(r.a).toEqual(["1402", "1403"]);                       // P1 minus 1401
    expect(r.b).toEqual(["1402", "1403", "2402", "2403"]);       // P1∪P2 minus 1401,2401
    expect(r.formula).toContain("−");

    // Topbar filter lists combined groups (value "c:<name>") and narrows the app.
    await page.click(`.nav-btn[data-nav="roster"]`);
    const opts = await page.$$eval("#filter-group option", els => els.map(e => ({ v: e.value, t: e.textContent })));
    expect(opts.some(o => o.v === "c:P1 − Guard" && /▣/.test(o.t))).toBe(true);
    await page.selectOption("#filter-group", "c:P1 − Guard");
    await page.waitForTimeout(150);
    const shown = await page.$$eval("table tbody tr td:first-child", tds => tds.map(t => t.textContent.trim()).filter(Boolean));
    expect(shown.sort()).toEqual(["1402", "1403"]);
    expect(await page.evaluate(() => filterLabel())).toContain("P1 − Guard");

    // Book-out scope: a "comb:" option books out exactly the resolved in-camp set.
    const targets = await page.evaluate(() => bookOutTargets("comb:P1+P2 − Guard").map(x => x.id).sort());
    expect(targets).toEqual(["1402", "1403", "2402", "2403"]);
    await page.evaluate(() => bookOutMany(bookOutTargets("comb:P1+P2 − Guard").map(x => x.id), "Duty"));
    const out = await page.evaluate(() => [...outOfCampMap(todayISO()).keys()].sort());
    expect(out).toEqual(["1402", "1403", "2402", "2403"]); // guard (1401,2401) stayed in

    // Delete clears a matching filter.
    await page.evaluate(() => { STATE.filterGroup = "c:P1 − Guard"; deleteCombined("P1 − Guard"); });
    const after = await page.evaluate(() => ({ names: allCombinedNames(), filter: STATE.filterGroup }));
    expect(after.names).toEqual(["P1+P2 − Guard"]);
    expect(after.filter).toBe("");
  });
});
