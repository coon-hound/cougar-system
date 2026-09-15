const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("force-in MC recruit stays under ATT C but is marked IN", async ({ page }) => {
  await seedAndGoto(page);
  const out = await page.evaluate(() => {
    const today = isoToDisplayDate(todayISO());
    const iso = todayISO();
    // 1401: MC away, NOT booked in -> should be in ATTC.
    STATE.medical.push({ id: 900001, d4: "1401", date: today, reason: "Fever", status: "MC", startDate: today, endDate: today, inCamp: false });
    // 1402: MC away, but manually Booked In today -> counted present, so the
    // ATT C line must carry the IN marker.
    STATE.medical.push({ id: 900002, d4: "1402", date: today, reason: "Ankle", status: "MC", startDate: today, endDate: today, inCamp: false });
    const r = STATE.roster.find(x => x.id === "1402"); r.campIn = true; r.campInSince = iso;
    saveLocal();
    return generateParadeStateText("FP", iso, "0730");
  });

  // Both recruits are PL 1, so their ATT C lines sit in the same block.
  const attc = out.split("\n").filter(l => /^\d+\. (1401|1402) /.test(l));
  expect(attc.some(l => /^1\. 1401 .* - 1D MC \(Fever\) \(\d{6}\)$/.test(l)), "away MC, no marker: " + attc).toBeTruthy();
  expect(attc.some(l => /^2\. 1402 .* - 1D MC \(Ankle\) \(\d{6}\) IN$/.test(l)), "booked-in MC marked IN: " + attc).toBeTruthy();
  // Counted present: 6 recruits + 1 commander, only 1401 away.
  expect(out).toContain("COMPANY: 6/7");
});
