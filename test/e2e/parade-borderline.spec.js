const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// Extended-MC scenario: a recruit reports sick outside, gets MC day-3..yesterday,
// then extends it — logged as a SECOND report-sick record covering today..tomorrow
// (the two-record convention tracks how many times they reported sick). The
// borderline-returnees checklist keys off "MC ended yesterday", so without
// looking for the extension it wrongly offers the recruit as booking in this
// morning. A recruit whose MC genuinely ended yesterday must still be listed.
test("extended MC is not a borderline returnee; genuinely-ended MC still is", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);

  await page.evaluate(() => {
    const iso = todayISO();
    const shift = (base, days) => {
      const d = new Date(base);
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const disp = i => isoToDisplayDate(i);
    // 1401: first report sick (MC ended yesterday) + extension logged as a
    // second report sick covering today..tomorrow. Still out of camp today.
    STATE.medical.push({ id: 910001, d4: "1401", date: disp(shift(iso, -3)), reason: "Fever", status: "MC", startDate: disp(shift(iso, -3)), endDate: disp(shift(iso, -1)), inCamp: false, location: "Polyclinic" });
    STATE.medical.push({ id: 910002, d4: "1401", date: disp(iso), reason: "Fever (extended)", status: "MC", startDate: disp(iso), endDate: disp(shift(iso, 1)), inCamp: false, location: "Polyclinic" });
    // 1402: MC genuinely ended yesterday, no extension -> real borderline returnee.
    STATE.medical.push({ id: 910003, d4: "1402", date: disp(shift(iso, -2)), reason: "Ankle", status: "MC", startDate: disp(shift(iso, -2)), endDate: disp(shift(iso, -1)), inCamp: false });
    saveLocal();
    openReportModal("FP");
  });

  const borderline = page.locator("#borderline-section");
  await expect(borderline).toContainText("1402");   // genuine returnee still offered
  await expect(borderline).not.toContainText("1401"); // extension covers today -> not a returnee

  // The extension keeps 1401 in ATTC (still out of camp) regardless of ticks.
  const text = await page.locator("#rep-text").inputValue();
  const attc = text.slice(text.indexOf("ATTC:"), text.indexOf("REPORT SICK:"));
  expect(attc).toContain("1401");

  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/parade-borderline.png", fullPage: true });
});
