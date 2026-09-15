// Adversarial end-to-end coverage for the 40 SAR parade state. The unit
// property test proves the TEXT is always well formed; this proves the real
// app produces it under the conditions the PDS actually meets on a phone:
// a full company morning with every section populated, the changeover day
// (yesterday's state is in the OLD format), a roster with no commanders, and
// the date being changed mid-modal.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const RULE_DASH = "-".repeat(32);
const SECTION_LINE = /^(ATT C|STATUS|REPORT SICK|MA|OFF\/LEAVE|OTHERS): (\d+)$/;
const RECORD_LINE = /^\d+\. \S.* - \S.*$/;
const STRENGTH_LINE = /^(COMPANY|COY HQ|PL [A-Z0-9]+|OFFICER|WOSPEC|ENLISTEE): (\d+)\/(\d+)$/;

// The same invariants the unit property test enforces, applied to whatever the
// live app just put in the textarea.
function violations(text) {
  const bad = [];
  const lines = text.split("\n");
  const nums = l => { const m = STRENGTH_LINE.exec(l); return m ? [+m[2], +m[3]] : null; };

  const known = l =>
    /^(40 SAR|FIRST PARADE|LAST PARADE|DATE: |CDO: |CDS: |COS: |PDS )/.test(l) ||
    /^[-=]{32}$/.test(l) || STRENGTH_LINE.test(l) || SECTION_LINE.test(l) || RECORD_LINE.test(l);
  lines.forEach((l, i) => { if (!known(l)) bad.push(`line ${i} is not part of the format: ${JSON.stringify(l)}`); });

  const company = nums(lines.find(l => l.startsWith("COMPANY: ")) || "");
  if (!company) bad.push("no COMPANY line");
  let sum = [0, 0];
  text.split("\n" + RULE_DASH + "\n").forEach(b => {
    const bl = b.split("\n");
    const i = bl.findIndex(l => /^(COY HQ|PL [A-Z0-9]+): \d+\/\d+$/.test(l));
    if (i < 0) return bad.push("block with no strength line");
    const head = nums(bl[i]);
    sum = [sum[0] + head[0], sum[1] + head[1]];
    const cats = bl.slice(i + 1, i + 4).map(nums);
    if (cats.some(c => !c)) return bad.push("block missing rank lines: " + bl[i]);
    const catSum = cats.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
    if (String(catSum) !== String(head)) bad.push(`rank lines do not sum to ${bl[i]}`);

    const order = [];
    let expecting = null, seen = 0;
    bl.forEach(l => {
      const sec = SECTION_LINE.exec(l);
      if (sec) {
        if (expecting && seen !== expecting.n) bad.push(`${expecting.name} claims ${expecting.n}, has ${seen}`);
        order.push(sec[1]); expecting = { name: sec[1], n: +sec[2] }; seen = 0;
        return;
      }
      if (RECORD_LINE.test(l)) { if (!expecting) bad.push("record outside a section: " + l); else seen++; }
    });
    if (expecting && seen !== expecting.n) bad.push(`${expecting.name} claims ${expecting.n}, has ${seen}`);
    if (String(order) !== "ATT C,STATUS,REPORT SICK,MA,OFF/LEAVE,OTHERS") bad.push("section order wrong: " + order);
  });
  if (company && String(sum) !== String(company)) bad.push(`blocks ${sum} do not sum to COMPANY ${company}`);
  return bad;
}

// A morning where every section has something in it, including the awkward
// combinations: an MC consumed in camp, a recruit holding two excuses, someone
// out on leave, a booked-out appointment, and free text full of the characters
// the line format reserves.
async function seedBusyMorning(page) {
  return page.evaluate(() => {
    const iso = todayISO();
    const d = n => { const x = new Date(iso); x.setUTCDate(x.getUTCDate() + n); return isoToDisplayDate(x.toISOString().slice(0, 10)); };
    STATE.medical.push(
      { id: 940001, d4: "1401", date: d(0), reason: "Fever (38.5) @ home", status: "MC", startDate: d(0), endDate: d(2), inCamp: false, location: "Raffles @ Sembawang" },
      { id: 940002, d4: "1402", date: d(0), reason: "High fever", status: "MC", startDate: d(0), endDate: d(1), inCamp: true, location: "" },
      { id: 940003, d4: "1403", date: d(0), reason: "Back pain", status: "Excuse RMJ", startDate: d(0), endDate: d(5), location: "" },
      { id: 940004, d4: "1403", date: d(0), reason: "Back pain", status: "Excuse Heavy Load", startDate: d(0), endDate: d(5), location: "" },
      { id: 940005, d4: "2401", date: d(0), reason: "Flu\npasted from chat", status: "Pending", startDate: d(0), endDate: d(0), location: "" },
      { id: 940006, d4: "2402", date: d(0), reason: "Dengue", status: "Warded", startDate: d(0), endDate: d(6), inCamp: false, location: "TTSH" }
    );
    STATE.leave.push(
      { id: 940007, d4: "2403", type: "Off-in-Lieu", startDate: d(0), endDate: d(1), days: 2, reason: "OIL" },
      { id: 940008, d4: "0001", type: "Guard Duty", startDate: d(0), endDate: d(0), days: 1, reason: "Coy guard" }
    );
    STATE.appointments.push(
      { id: 940009, d4: "1403", date: d(3), time: "1420", reason: "Physio", location: "CGH", outOfCamp: false, resolved: false },
      { id: 940010, d4: "1401", date: d(0), time: "0800-1200", reason: "Review", location: "NDC", outOfCamp: true, resolved: false }
    );
    saveLocal(); render();
  });
}

test("a full company morning produces a well-formed state, with no console errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);
  await seedBusyMorning(page);

  await page.evaluate(() => openReportModal("FP"));
  await page.fill("#rep-time", "0700");
  await page.locator("button[type=submit]", { hasText: "Regenerate" }).click();
  const text = await page.locator("#rep-text").inputValue();
  expect(violations(text), "format invariants:\n" + text).toEqual([]);

  // The awkward cases each land where the battalion's table says they should.
  const line = re => text.split("\n").find(l => re.test(l)) || "";
  expect(line(/1402 /), "in-camp MC stays in ATT C, marked IN").toMatch(/- 2D MC \(High fever\) \(\d{6}-\d{6}\) IN$/);
  expect(line(/1403 .*EXCUSE/), "two excuses sharing a span are one line").toMatch(/EXCUSE RMJ, HEAVY LOAD \(Back pain\)/);
  expect(line(/2402 /), "Warded files under OTHERS").toMatch(/- \d+D WARDED \(Dengue\)/);
  expect(line(/2401 /), "a pasted newline never splits a record").toMatch(/- RSI \(Flu pasted from chat\) \(\d{6}\)$/);
  expect(line(/1401 .* MA /), "an out-of-camp appt is filed under MA with OUT").toMatch(/- MA \(Review\) \(\d{6} 0800-1200\) OUT @ NDC/);
  expect(text).toContain("(Fever 38.5 at home)");        // reserved characters neutralised
  expect(text).toContain("@ Raffles at Sembawang");

  // Nobody is listed as away twice: 1401 holds an MC AND a booked-out appt.
  expect(text.split("\n").filter(l => /^\d+\. 1401 /.test(l)).length).toBe(2);   // one ATT C, one MA
  expect(text).not.toMatch(/^\d+\. 1401 .*OUT OF CAMP/m);

  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/parade-40sar-stress.png", fullPage: true });
});

test("changeover day: yesterday's OLD-format state still compares against today's", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);

  // Yesterday was filed in the pre-Sep-2026 S/N-block format and archived as a
  // snapshot. Snapshots are never regenerated, so this text is exactly what the
  // compare engine will be handed on the first morning after the changeover.
  await page.evaluate(() => {
    const iso = todayISO();
    const dd = s => s.slice(8, 10) + s.slice(5, 7) + s.slice(2, 4);
    const SEP = "-".repeat(64);
    const old = [
      "COUGAR COMPANY", "FIRST PARADE STATE", `DATE: ${dd(iso)} @ 0700 Hrs`, "", SEP, "",
      "TOTAL STRENGTH: 7", "CURRENT STRENGTH: 6", "PLATOON 1: 2/3", "PLATOON 2: 3/3", "COMMANDERS: 1/1", "",
      SEP, "", "ATTC: 01", "", "S/N: 01", "R/N: REC ALPHA ONE C1401", "Reason: HFMD",
      "Status: 2D MC", `Duration: ${dd(iso)} - ${dd(iso)}`, "",
      SEP, "", "REPORT SICK:", "", "S/N:", "R/N:", "Reason:", "",
      SEP, "", "MEDICAL STATUS:", "", "S/N:", "R/N:", "Reason:", "",
      SEP, "", "MEDICAL APPT:", "", "S/N:", "R/N:", "Reason:", "Location:", "Date:", "Time:", "",
      SEP, "", "OTHERS:", "", "S/N:", "R/N:", "Reason:", "Duration:", "", SEP
    ].join("\n");
    saveParadeSnapshot("FP", iso, "0700", old);
    // Today: ALPHA ONE is back, ALPHA TWO went out on an MC instead.
    const d = isoToDisplayDate(iso);
    STATE.medical.push({ id: 950001, d4: "1402", date: d, reason: "Gastric flu", status: "MC", startDate: d, endDate: d, inCamp: false });
    saveLocal(); render();
  });

  await page.locator("button", { hasText: "Generate Report" }).click();
  await page.locator("#report-menu button", { hasText: "First Parade State" }).click();
  await page.locator("button", { hasText: "Compare with previous" }).click();
  await page.locator("button", { hasText: "🔍 Compare" }).click();

  const results = page.locator("#cmp-results");
  // Structured cards, not the raw-text fallback: the old format is still read.
  await expect(results.locator(".cmp-group-head", { hasText: "Newly listed" })).toBeVisible();
  await expect(results.locator(".cmp-card-out")).toContainText("1402");
  await expect(results.locator(".cmp-card-out")).toContainText("Gastric flu");
  await expect(results.locator(".cmp-group-head", { hasText: "No longer listed" })).toBeVisible();
  await expect(results.locator(".cmp-card-ret")).toContainText("ALPHA ONE");
  // Both sides' section names resolve to the same canonical section.
  await expect(results.locator(".cmp-card-out .badge", { hasText: "ATT C" })).toBeVisible();

  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/parade-40sar-changeover.png", fullPage: true });
});

test("a roster with no commanders still files a state, and says the team is empty", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);
  await page.evaluate(() => {
    STATE.roster = STATE.roster.filter(r => r.role !== "Commander");
    saveLocal(); render();
    openReportModal("FP");
  });

  await expect(page.locator("#duty-section")).toContainText("No commanders in the roster yet");
  const text = await page.locator("#rep-text").inputValue();
  expect(violations(text), text).toEqual([]);
  expect(text).toContain("CDO: <RANK> <NAME>");
  expect(text).toMatch(/^COY HQ: 0\/0$/m);
  expect(errors).toEqual([]);
});

test("changing the parade date re-renders the command team and the state", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);
  await page.evaluate(() => openReportModal("FP"));

  const cdo = page.locator("#duty-section label", { hasText: "CDO" }).locator("select");
  await cdo.selectOption({ index: 1 });
  const picked = (await cdo.locator("option:checked").innerText()).trim();

  // A later date inherits today's team as its starting point…
  const today = await page.locator("#rep-date").inputValue();
  const tomorrow = await page.evaluate(() => {
    const x = new Date(todayISO()); x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
  });
  await page.fill("#rep-date", tomorrow);
  await expect(page.locator("#duty-section label", { hasText: "CDO" }).locator("option:checked")).toHaveText(picked);
  const text = await page.locator("#rep-text").inputValue();
  expect(text).toContain(`CDO: ${picked.toUpperCase()}`);
  expect(text).toContain(`DATE: ${tomorrow.slice(8, 10)}${tomorrow.slice(5, 7)}${tomorrow.slice(2, 4)}`);
  expect(violations(text), text).toEqual([]);

  // …and an EARLIER date does not inherit from the future: what was filed
  // yesterday must not be rewritten by a team picked today.
  const yesterday = await page.evaluate(() => {
    const x = new Date(todayISO()); x.setUTCDate(x.getUTCDate() - 1);
    return x.toISOString().slice(0, 10);
  });
  await page.fill("#rep-date", yesterday);
  await expect(page.locator("#duty-section label", { hasText: "CDO" }).locator("option:checked")).toHaveText("— not set —");
  expect(await page.locator("#rep-text").inputValue()).toContain("CDO: <RANK> <NAME>");

  // Returning to today restores the team saved against today.
  await page.fill("#rep-date", today);
  await expect(page.locator("#duty-section label", { hasText: "CDO" }).locator("option:checked")).toHaveText(picked);
  expect(errors).toEqual([]);
});

test("the view filter never narrows the parade state", async ({ page }) => {
  // The topbar scope filter narrows every per-recruit view. A parade state is
  // the WHOLE company by definition, so a PDS who left the app filtered to one
  // platoon must not file a state missing two thirds of the company.
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);
  await seedBusyMorning(page);

  const unfiltered = await page.evaluate(() => { openReportModal("FP"); const t = document.getElementById("rep-text").value; closeModal(); return t; });
  const filtered = await page.evaluate(() => {
    STATE.filterPlt = "1";
    STATE.filterSect = "4";
    STATE.filterRole = "Recruit";
    saveFilter(); render();
    openReportModal("FP");
    return document.getElementById("rep-text").value;
  });

  expect(violations(filtered), filtered).toEqual([]);
  expect(filtered).toBe(unfiltered);
  expect(filtered).toMatch(/^COMPANY: \d+\/7$/m);
  expect(filtered).toMatch(/^PL 2: /m);          // the filtered-out platoon is still filed
  expect(filtered).toMatch(/^COY HQ: \d\/1$/m);   // …and so is the commander
  expect(errors).toEqual([]);
});

test("copy archives the new format and the change summary reads it back", async ({ page }) => {
  page.on("dialog", d => d.accept());   // headless clipboard is blocked → alert fallback
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);
  await seedBusyMorning(page);

  await page.locator("button", { hasText: "Generate Report" }).click();
  await page.locator("#report-menu button", { hasText: "First Parade State" }).click();
  await page.fill("#rep-time", "0700");
  await page.locator("button[type=submit]", { hasText: "Regenerate" }).click();
  await page.locator("#rep-copy-btn").click();

  const snap = await page.evaluate(() => JSON.parse(localStorage.getItem("cougar-parade-snapshots") || "{}"));
  expect(snap.snapshots.length).toBe(1);
  expect(violations(snap.snapshots[0].text), "the archived text is the format").toEqual([]);

  // The archived state parses back into the same people the app knows are out.
  const readback = await page.evaluate(text => {
    const p = parseParadeState(text);
    return { confidence: p.confidence, unparsed: p.unparsed, warnings: p.warnings, people: p.people.length,
             current: p.strength.current, total: p.strength.total };
  }, snap.snapshots[0].text);
  expect(readback.unparsed).toEqual([]);
  expect(readback.warnings).toEqual([]);
  expect(readback.confidence).toBe("ours");
  expect(readback.people).toBeGreaterThan(5);
  expect(readback.total).toBe(7);

  expect(errors).toEqual([]);
});
