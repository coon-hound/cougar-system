// Log Conduct wizard — Status Personnel checklist revamp: whole-row <label>
// tap targets, severity-aware sorting, and the filter chips (participation
// segment + status-family multi-select). Filters are view-only: totals always
// compute from the full state list, never from what's visible.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const visibleD4s = page =>
  page.$$eval("#wiz-status-list .lc-wiz-status-row", els => els.map(e => e.dataset.d4));

test.describe("Log Conduct wizard: status checklist", () => {
  test.beforeEach(async ({ page }) => {
    await seedAndGoto(page);
    page.on("dialog", d => d.accept());
    await page.evaluate(() => {
      const today = isoToDisplayDate(todayISO());
      // A participating custom status, a spread of built-ins, one multi-status
      // recruit (MC + Excuse) — covers every sort tier and filter family.
      addCustomStatus("Blister", /*participates*/ true);
      STATE.medical.push(
        { id: 901, d4: "2401", date: today, reason: "flu", status: "MC", startDate: today, endDate: today, inCamp: false },
        { id: 902, d4: "2402", date: today, reason: "flu", status: "MC", startDate: today, endDate: today, inCamp: false },
        { id: 903, d4: "2402", date: today, reason: "back", status: "Excuse Heavy Load", startDate: today, endDate: today, inCamp: false },
        { id: 904, d4: "1401", date: today, reason: "ankle", status: "LD", startDate: today, endDate: today, inCamp: false },
        { id: 905, d4: "1402", date: today, reason: "shoulder", status: "Excuse Heavy Load", startDate: today, endDate: today, inCamp: false },
        { id: 906, d4: "1403", date: today, reason: "heel", status: "Blister", startDate: today, endDate: today, inCamp: false }
      );
      saveLocal();
      openLogConductWizard();
      wizSetProgram("Combined");
      wizSetTime("1000");
      wizSetConductId("c001");
    });
    await page.waitForSelector("#wiz-status-list");
  });

  test("rows sort needs-attention first, then severity, then d4", async ({ page }) => {
    // Not-participating defaults first (MC, MC+Excuse, LD, Excuse), the
    // participating-by-default custom status last.
    expect(await visibleD4s(page)).toEqual(["2401", "2402", "1401", "1402", "1403"]);
    // Multi-status recruit shows the stacked tag.
    expect(await page.$eval('.lc-wiz-status-row[data-d4="2402"] .lc-wiz-status-tag', el => el.textContent))
      .toBe("MC + Excuse Heavy Load");
  });

  test("whole row is a tap target; the reason input is not", async ({ page }) => {
    // 1403 (Blister, participates) starts unticked.
    const cb = '.lc-wiz-status-row[data-d4="1403"] input[type=checkbox]';
    expect(await page.$eval(cb, el => el.checked)).toBe(false);
    expect(await page.$eval("#wiz-stat-status", el => el.textContent)).toBe("4");

    // Tapping the NAME (not the checkbox) toggles not-participating.
    await page.click('.lc-wiz-status-row[data-d4="1403"] .lc-wiz-status-name');
    expect(await page.$eval(cb, el => el.checked)).toBe(true);
    expect(await page.$eval('.lc-wiz-status-row[data-d4="1403"]', el => el.classList.contains("np"))).toBe(true);
    expect(await page.$eval("#wiz-stat-status", el => el.textContent)).toBe("5");

    // Tapping + typing in the reason input must NOT toggle the checkbox.
    const reason = '.lc-wiz-status-row[data-d4="1403"] input[type=text]';
    await page.click(reason);
    await page.fill(reason, "resting today");
    expect(await page.$eval(cb, el => el.checked)).toBe(true);
    const state = await page.evaluate(() => _logConduct.status.find(s => s.d4 === "1403"));
    expect(state.notParticipating).toBe(true);
    expect(state.reason).toBe("resting today");

    // The checkbox itself still works (no double-toggle through the label).
    await page.click('.lc-wiz-status-row[data-d4="2401"] input[type=checkbox]');
    expect(await page.$eval('.lc-wiz-status-row[data-d4="2401"] input[type=checkbox]', el => el.checked)).toBe(false);
    expect(await page.$eval("#wiz-stat-status", el => el.textContent)).toBe("4");
  });

  test("participation segment and family chips filter the list, never the totals", async ({ page }) => {
    // Segment: Participating shows only the Blister recruit.
    await page.click('.lc-wiz-filter-chip >> text="Participating (1)"');
    expect(await visibleD4s(page)).toEqual(["1403"]);
    expect(await page.$eval("#wiz-status-list", el => el.textContent)).toContain("Showing 1 of 5");

    await page.click('.lc-wiz-filter-chip >> text="Not participating (4)"');
    expect(await visibleD4s(page)).toEqual(["2401", "2402", "1401", "1402"]);

    await page.click('.lc-wiz-filter-chip >> text="All (5)"');
    expect(await visibleD4s(page)).toEqual(["2401", "2402", "1401", "1402", "1403"]);

    // Family chip: MC matches both the pure-MC and the multi-status recruit.
    await page.click('.lc-wiz-filter-chip >> text="MC (2)"');
    expect(await visibleD4s(page)).toEqual(["2401", "2402"]);
    // Hidden rows still count in the footer totals.
    expect(await page.$eval("#wiz-stat-status", el => el.textContent)).toBe("4");

    // Multi-select: adding LD widens the visible set.
    await page.click('.lc-wiz-filter-chip >> text="LD (1)"');
    expect(await visibleD4s(page)).toEqual(["2401", "2402", "1401"]);

    // Clearing both chips restores everything.
    await page.click('.lc-wiz-filter-chip >> text="MC (2)"');
    await page.click('.lc-wiz-filter-chip >> text="LD (1)"');
    expect(await visibleD4s(page)).toEqual(["2401", "2402", "1401", "1402", "1403"]);
  });
});
