const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("bulk book-out by platoon / group / company", async ({ page }) => {
  await seedAndGoto(page);
  page.on("dialog", d => d.accept()); // auto-accept the confirm()

  // Put 2401 on an active MC (out) so bulk book-out must SKIP it.
  await page.evaluate(() => {
    const today = isoToDisplayDate(todayISO());
    STATE.medical.push({ id: 900001, d4: "2401", date: today, reason: "Fever", status: "MC", startDate: today, endDate: today, inCamp: false });
    saveLocal(); render();
  });

  // Target counts: seed is plt1 = 1401/1402/1403, plt2 = 2401/2402/2403.
  // A group is the cross-platoon scope now that programs are gone.
  await page.evaluate(() => {
    STATE.roster.filter(r => ["2401", "2402", "2403"].includes(r.id))
      .forEach(r => { r.groups = "Guard Duty"; });
    saveLocal(); render();
  });
  const counts = await page.evaluate(() => ({
    company: bookOutTargets("company").map(r => r.id).sort(),
    plt1: bookOutTargets("plt:1").map(r => r.id).sort(),
    grp: bookOutTargets("grp:Guard Duty").map(r => r.id).sort(),
  }));
  expect(counts.plt1).toEqual(["1401", "1402", "1403"]);
  expect(counts.grp).toEqual(["2402", "2403"]);      // 2401 skipped (on MC)
  expect(counts.company).toEqual(["1401", "1402", "1403", "2402", "2403"]); // 2401 excluded

  // Book out Platoon 1 in bulk; only those three flip, nobody else.
  const res = await page.evaluate(() => {
    const n = bookOutMany(bookOutTargets("plt:1").map(r => r.id), "Outfield");
    const m = outOfCampMap(todayISO());
    return { n, out: [...m.keys()].sort(), r1401: m.get("1401") };
  });
  expect(res.n).toBe(3);
  expect(res.out).toEqual(["1401", "1402", "1403", "2401"]); // plt1 booked out + 2401's MC
  expect(res.r1401.kind).toBe("bookedout");
  expect(res.r1401.reason).toBe("Outfield");

  // Book Out modal UI: scope options include company + platoon + group with
  // counts, and the single-person dropdown hides for a bulk scope.
  await page.click(`.nav-btn[data-nav="dashboard"]`);
  await page.click("text=+ Book Out");
  const opts = await page.$$eval("#f-bo-scope option", els => els.map(e => e.textContent));
  expect(opts.some(o => /Whole company/.test(o))).toBe(true);
  expect(opts.some(o => /Platoon 2/.test(o))).toBe(true);
  expect(opts.some(o => /Guard Duty/.test(o))).toBe(true);
  await page.selectOption("#f-bo-scope", "company");
  await page.waitForTimeout(50);
  const recruitHidden = await page.$eval("#f-bo-person-wrap", el => el.style.display === "none");
  expect(recruitHidden).toBe(true);
});
