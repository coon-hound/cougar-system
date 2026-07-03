// Feature spec for the Roster "Camp" column. It must read the SHARED out-of-camp
// definition (outOfCampMap) so it can never disagree with the dashboard / parade
// strength — medical + leave count as out, not just manual book-outs — while the
// manual Book out / Book in lever stays available on EVERY row so a SPEC can
// control in-camp strength (e.g. send out a recruit consuming MC in camp).
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// Reads the {status, campBadge, campBtn} for a recruit's roster row.
function campOf(page, d4) {
  return page.evaluate((id) => {
    const tr = [...document.querySelectorAll("table tbody tr")].find(r => r.textContent.includes(id) && r.querySelector("td"));
    if (!tr) return null;
    const tds = [...tr.querySelectorAll("td")];
    return {
      status: tds[3]?.innerText.trim(),
      campBadge: tds[4]?.querySelector("span")?.innerText.trim(),
      campBtn: tds[4]?.querySelector("button")?.innerText.trim(),
    };
  }, d4);
}

test.describe("Roster Camp column = shared out-of-camp status + manual lever", () => {
  test("badge matches outOfCampMap and the book-out/in lever is always present", async ({ page }) => {
    await seedAndGoto(page);

    await page.evaluate(() => {
      const today = isoToDisplayDate(todayISO());
      // 1401: MC out of camp (physically away).
      STATE.medical.push({ id: nextId(), d4: "1401", date: today, reason: "Fever", status: "MC", startDate: today, endDate: today, inCamp: false });
      // 1402: MC consumed IN camp -> counted present, but must stay bookable-out.
      STATE.medical.push({ id: nextId(), d4: "1402", date: today, reason: "Cough", status: "MC", startDate: today, endDate: today, inCamp: true });
      // 1403: manual book-out.
      const r = STATE.roster.find(x => x.id === "1403");
      r.outOfCamp = true; r.outSince = todayISO(); r.outReason = "Family matter";
      saveLocal(); render();
    });
    await page.click(`.nav-btn[data-nav="roster"]`);

    const c1401 = await campOf(page, "1401");
    const c1402 = await campOf(page, "1402");
    const c1403 = await campOf(page, "1403");
    const c2401 = await campOf(page, "2401");

    // The lever always offers the opposite of the effective state.
    // Out via medical -> "Out · Medical", button offers Book in.
    expect(c1401.campBadge).toContain("Medical");
    expect(c1401.campBtn).toContain("Book in");
    // MC consumed in camp -> present ("In camp"), button offers Book out.
    expect(c1402.campBadge).toBe("In camp");
    expect(c1402.campBtn).toContain("Book out");
    // Manual book-out -> "Out · Booked out" with a Book in to pull them back.
    expect(c1403.campBadge).toContain("Booked out");
    expect(c1403.campBtn).toContain("Book in");
    // Untouched recruit -> in camp with a Book out lever.
    expect(c2401.campBadge).toBe("In camp");
    expect(c2401.campBtn).toContain("Book out");

    // The roster badge can never disagree with the shared out-of-camp set.
    const dashOut = await page.evaluate(() => [...outOfCampMap(todayISO()).keys()].sort());
    expect(dashOut).toEqual(["1401", "1403"]); // 1402 (in-camp MC) is present

    // Booking the in-camp-MC recruit OUT raises the out-of-camp count by one.
    const before = await page.evaluate(() => outOfCampMap(todayISO()).size);
    await page.evaluate(() => bookOutToggle("1402", true, "Manual"));
    const after = await page.evaluate(() => outOfCampMap(todayISO()).size);
    expect(after).toBe(before + 1);

    // Book IN on an MC recruit overrides them present for the day (strength -1),
    // shows as "In camp · manual", and the badge stays consistent with the map.
    await page.evaluate(() => bookOutToggle("1401", false));
    const overridden = await page.evaluate(() => ({
      out: outOfCampMap(todayISO()).has("1401"),
      forcedIn: isForcedIn(STATE.roster.find(r => r.id === "1401"), todayISO()),
    }));
    expect(overridden.out).toBe(false);       // no longer counted out
    expect(overridden.forcedIn).toBe(true);
    await page.click(`.nav-btn[data-nav="dashboard"]`);
    await page.click(`.nav-btn[data-nav="roster"]`);
    const c1401b = await campOf(page, "1401");
    expect(c1401b.campBadge).toContain("manual");
    expect(c1401b.campBtn).toContain("Book out");

    // The override is day-scoped: yesterday's Book In does NOT carry over, so the
    // recruit reverts to "Out · Medical" the next day with no cron.
    const revert = await page.evaluate(() => {
      const r = STATE.roster.find(x => x.id === "1401");
      r.campInSince = "2000-01-01"; // pretend it was set on a past day
      return outOfCampMap(todayISO()).has("1401");
    });
    expect(revert).toBe(true);
  });
});
