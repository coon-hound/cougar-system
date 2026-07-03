const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("force-in MC recruit is out of ATTC and under MEDICAL STATUS", async ({ page }) => {
  await seedAndGoto(page);
  const out = await page.evaluate(() => {
    const today = isoToDisplayDate(todayISO());
    const iso = todayISO();
    // 1401: MC away, NOT booked in -> should be in ATTC.
    STATE.medical.push({ id: 900001, d4: "1401", date: today, reason: "Fever", status: "MC", startDate: today, endDate: today, inCamp: false });
    // 1402: MC away, but manually Booked In today -> present, must leave ATTC.
    STATE.medical.push({ id: 900002, d4: "1402", date: today, reason: "Ankle", status: "MC", startDate: today, endDate: today, inCamp: false });
    const r = STATE.roster.find(x => x.id === "1402"); r.campIn = true; r.campInSince = iso;
    saveLocal();
    return generateParadeStateText("FP", iso, "0730");
  });

  // Split into the ATTC and MEDICAL STATUS sections.
  const attc = out.slice(out.indexOf("ATTC:"), out.indexOf("REPORT SICK:"));
  const medStatus = out.slice(out.indexOf("MEDICAL STATUS:"));

  expect(attc).toContain("1401");            // still away
  expect(attc).not.toContain("1402");        // kept in camp -> not in ATTC
  expect(medStatus).toContain("1402");       // shows under MEDICAL STATUS
  expect(medStatus).toContain("(kept in camp)");
});
