const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Book In by scope (inverse of book-out)", () => {
  test("bookInTargets/bookInMany act only on out-of-camp recruits in scope", async ({ page }) => {
    await seedAndGoto(page);
    page.on("dialog", d => d.accept());

    await page.evaluate(() => {
      const today = isoToDisplayDate(todayISO());
      setGroupMembers("Guard Duty", ["1401", "2401", "2402"]);
      // Book the group OUT first (bulk book-out).
      bookOutMany(bookOutTargets("grp:Guard Duty").map(r => r.id), "Guard");
      // 2403 out on MC (in scope of P2, not the group) to prove book-in force-presents.
      STATE.medical.push({ id: 71, d4: "2403", date: today, reason: "x", status: "MC", startDate: today, endDate: today, inCamp: false });
      saveLocal();
    });

    const before = await page.evaluate(() => ({
      out: [...outOfCampMap(todayISO()).keys()].sort(),
      inTargetsGrp: bookInTargets("grp:Guard Duty").map(r => r.id).sort(),
    }));
    expect(before.out).toEqual(["1401", "2401", "2402", "2403"]);
    expect(before.inTargetsGrp).toEqual(["1401", "2401", "2402"]); // only the out ones in the group

    // Book the group back IN — they leave the out-of-camp set; 2403 (MC) stays out.
    const after = await page.evaluate(() => {
      const n = bookInMany(bookInTargets("grp:Guard Duty").map(r => r.id));
      return { n, out: [...outOfCampMap(todayISO()).keys()].sort() };
    });
    expect(after.n).toBe(3);
    expect(after.out).toEqual(["2403"]);

    // Book-in on an MC recruit force-presents them (P2 scope catches 2403).
    const forced = await page.evaluate(() => {
      bookInMany(bookInTargets("plt:2").map(r => r.id));
      const r = STATE.roster.find(x => x.id === "2403");
      return { out: outOfCampMap(todayISO()).has("2403"), forcedIn: isForcedIn(r, todayISO()) };
    });
    expect(forced.out).toBe(false);
    expect(forced.forcedIn).toBe(true);

    // Dashboard picker: "↩ Book In" opens the book-in picker with out-of-camp counts.
    await page.evaluate(() => { bookOutMany(bookOutTargets("plt:1").map(r => r.id), "x"); });
    await page.click(`.nav-btn[data-nav="dashboard"]`);
    await page.click("text=↩ Book In");
    await page.waitForTimeout(150);
    const title = await page.textContent("#modal-title");
    expect(title).toContain("Book In");
    const opts = await page.$$eval("#f-bo-scope option", els => els.map(e => e.textContent));
    expect(opts.some(o => /Platoon 1/.test(o))).toBe(true);
  });
});
