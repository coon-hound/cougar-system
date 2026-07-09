const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Leave/Out by group scope", () => {
  test("scope resolves recruits and bulk-logs one leave entry each", async ({ page }) => {
    await seedAndGoto(page);
    page.on("dialog", d => d.accept());

    // A group across platoons + a combined group.
    await page.evaluate(() => {
      setGroupMembers("Guard Duty", ["1401", "2401", "2402"]);
      STATE.combinedGroups = [{ name: "P1 − Guard", include: ["plt:1"], exclude: ["grp:Guard Duty"] }];
      saveCombinedGroups();
    });

    // scopeRecruits: NOT camp-filtered (unlike bookOutTargets) — even someone on
    // MC is included, since you can put them on leave.
    const model = await page.evaluate(() => {
      const today = isoToDisplayDate(todayISO());
      STATE.medical.push({ id: 91, d4: "2401", date: today, reason: "x", status: "MC", startDate: today, endDate: today, inCamp: false });
      return {
        grp: scopeRecruits("grp:Guard Duty").sort(),
        comb: scopeRecruits("comb:P1 − Guard").sort(),
        plt2: scopeRecruits("plt:2").sort(),
        person: scopeRecruits("person"),
      };
    });
    expect(model.grp).toEqual(["1401", "2401", "2402"]);   // 2401 (on MC) still included
    expect(model.comb).toEqual(["1402", "1403"]);
    expect(model.plt2).toEqual(["2401", "2402", "2403"]);
    expect(model.person).toEqual([]);

    // Drive the real Book Out modal in Date range mode: pick a group scope,
    // log, one Leave entry per member.
    await page.click(`.nav-btn[data-nav="leave"]`);
    await page.click("text=+ Log");
    await page.waitForTimeout(150);
    await page.click("#f-bo-pill-range");
    await page.waitForTimeout(50);
    // "Apply to" selector exists; picking a group hides the person picker.
    const opts = await page.$$eval("#f-bo-scope option", els => els.map(e => e.textContent));
    expect(opts.some(o => /Guard Duty/.test(o))).toBe(true);
    expect(opts.some(o => /P1 − Guard/.test(o))).toBe(true);
    await page.selectOption("#f-bo-scope", "grp:Guard Duty");
    await page.waitForTimeout(50);
    expect(await page.$eval("#f-bo-person-wrap", el => el.style.display)).toBe("none");
    await page.fill("#f-bo-reason", "Guard mounting");
    await page.click("#modal-body button[type=submit]");
    await page.waitForTimeout(150);

    const leave = await page.evaluate(() => STATE.leave.filter(l => l.reason === "Guard mounting").map(l => l.d4).sort());
    expect(leave).toEqual(["1401", "2401", "2402"]);
  });
});
