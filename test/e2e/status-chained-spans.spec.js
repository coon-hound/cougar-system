const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// Back-to-back statuses ("chained records"): a recruit gets MC for two days,
// then extends it with a SECOND record starting the day the first ends + 1.
// Each record on its own is only "active" inside its own window, so a naive
// read reports the recruit back on day 3 when they are really out until day 5.
// The parade state, the medical status list, the conduct chat format and the
// dashboard must all report the TRUE end of the run.
//
// Timeline (relative to today = D0):
//   C1401  MC  D0..D1   +  MC  D2..D3    -> one run D0..D3, back on D4
//   C1402  MC  D0..D1   (no extension)   -> genuinely back on D2
//   C1403  MC  D0..D1   +  MC  D4..D5    -> a real gap; today's run ends D1
async function seedChain(page) {
  return page.evaluate(() => {
    const iso = todayISO();
    // Date-only strings parse as UTC, so shifting + re-serialising is timezone-safe.
    const shift = d => { const x = new Date(iso); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
    const disp = d => isoToDisplayDate(shift(d));
    const ddmmyy = d => { const s = shift(d); return s.slice(8, 10) + s.slice(5, 7) + s.slice(2, 4); };
    STATE.medical.push(
      { id: 920001, d4: "1401", date: disp(0), reason: "Fever", status: "MC", startDate: disp(0), endDate: disp(1), inCamp: false, location: "Polyclinic" },
      { id: 920002, d4: "1401", date: disp(2), reason: "Fever (extended)", status: "MC", startDate: disp(2), endDate: disp(3), inCamp: false, location: "Polyclinic" },
      { id: 920003, d4: "1402", date: disp(0), reason: "Ankle", status: "MC", startDate: disp(0), endDate: disp(1), inCamp: false },
      { id: 920004, d4: "1403", date: disp(0), reason: "Flu", status: "MC", startDate: disp(0), endDate: disp(1), inCamp: false },
      { id: 920005, d4: "1403", date: disp(4), reason: "Flu relapse", status: "MC", startDate: disp(4), endDate: disp(5), inCamp: false }
    );
    saveLocal(); render();
    return { d0: ddmmyy(0), d1: ddmmyy(1), d3: ddmmyy(3), d5: ddmmyy(5) };
  });
}

// Slice one "LABEL: nn ... " section out of the generated parade text.
function section(text, label) {
  return text.split(/\n-{10,}\n/).map(s => s.trim()).find(p => p.startsWith(label + ":")) || "";
}

test("parade state reports the full span of a chained (extended) MC", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);
  const D = await seedChain(page);

  await page.evaluate(() => openReportModal("FP"));
  const text = await page.locator("#rep-text").inputValue();
  const attc = section(text, "ATTC");

  // C1401's run really ends on D3 — the report must not stop at D1.
  const block1401 = attc.split(/\n\n(?=S\/N:)/).find(b => b.includes("C1401"));
  expect(block1401, "ATTC has a block for C1401").toBeTruthy();
  expect(block1401).toContain(`Duration: ${D.d0} - ${D.d3}`);
  expect(block1401).toContain("4D MC");

  // A single un-extended MC is untouched.
  const block1402 = attc.split(/\n\n(?=S\/N:)/).find(b => b.includes("C1402"));
  expect(block1402).toContain(`Duration: ${D.d0} - ${D.d1}`);
  expect(block1402).toContain("2D MC");

  // A LATER, non-adjacent MC is a separate absence — today's run still ends D1.
  const block1403 = attc.split(/\n\n(?=S\/N:)/).find(b => b.includes("C1403"));
  expect(block1403).toContain(`Duration: ${D.d0} - ${D.d1}`);
  expect(block1403).not.toContain(D.d5);

  expect(errors).toEqual([]);
});

test("dashboard reports the true end + return date of a chained MC", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);
  await seedChain(page);
  await page.locator('.nav-btn[data-nav="dashboard"]').click();

  const dates = await page.evaluate(() => {
    const at = d => { const x = new Date(todayISO()); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
    const shift = d => isoToDisplayDate(at(d));
    const shortBack = d => isoToShortDate(at(d));
    return { runEnd: shift(3), back: shortBack(4), firstEnd: shift(1) };
  });

  // "Currently Out of Camp" spells out when the recruit is actually back.
  const outRow = page.locator("#content table tr", { hasText: "ALPHA ONE" }).first();
  await expect(outRow).toContainText(`back ${dates.back}`);

  // Non-Active Personnel (the table with a Duration column) reports the merged span.
  const nonActive = page.locator("#content table", { has: page.locator("th", { hasText: "Duration" }) }).first();
  const durRow = nonActive.locator("tr", { hasText: "ALPHA ONE" });
  await expect(durRow).toContainText(`${dates.runEnd} (4D, extended)`);
  await expect(durRow).not.toContainText(`${dates.firstEnd} (2D)`);

  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/status-chained-spans.png", fullPage: true });
});

test("back-to-back leave reads as one absence in OTHERS and on the dashboard", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);

  const D = await page.evaluate(() => {
    const iso = todayISO();
    const shift = d => { const x = new Date(iso); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
    const disp = d => isoToDisplayDate(shift(d));
    const ddmmyy = d => { const s = shift(d); return s.slice(8, 10) + s.slice(5, 7) + s.slice(2, 4); };
    // Two Off-in-Lieu blocks with no gap: 1402 is away D0..D3, back on D4.
    STATE.leave.push(
      { id: 930001, d4: "1402", type: "Off-in-Lieu", startDate: disp(0), endDate: disp(1), days: 2, reason: "OIL" },
      { id: 930002, d4: "1402", type: "Off-in-Lieu", startDate: disp(2), endDate: disp(3), days: 2, reason: "OIL" }
    );
    saveLocal(); render();
    return { d0: ddmmyy(0), d3: ddmmyy(3), back: isoToShortDate(shift(4)), runEnd: disp(3) };
  });

  await page.evaluate(() => openReportModal("FP"));
  const others = section(await page.locator("#rep-text").inputValue(), "OTHERS");
  expect(others).toContain(`Duration: ${D.d0} - ${D.d3}`);
  await page.evaluate(() => closeModal());

  // Dashboard: the return date and the merged range both reflect both blocks.
  await page.locator('.nav-btn[data-nav="dashboard"]').click();
  await expect(page.locator("#content table tr", { hasText: "ALPHA TWO" }).first()).toContainText(`back ${D.back}`);
  const leaveTable = page.locator("#content table", { has: page.locator("th", { hasText: "Dates" }) }).first();
  await expect(leaveTable.locator("tr", { hasText: "ALPHA TWO" })).toContainText(`${D.runEnd} (extended)`);

  expect(errors).toEqual([]);
});
