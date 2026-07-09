// Log Conduct wizard — group scoping. The wizard's `program` field widened
// from bare program keys ("PTP"/"BMT"/"Combined") to also carry scope tokens
// ("plt:N"/"grp:NAME"/"comb:NAME"): same field, same sheet column, same dedup
// tuple. These specs drive the real modal end-to-end: pick a group scope,
// verify the status list + Total Str shrink to the group, save, re-open, and
// prove the token round-trips without duplicating detail rows.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Log Conduct wizard: group scoping", () => {
  test("scope dropdown lists groups; token saves, scopes the wizard, and round-trips on edit", async ({ page }) => {
    await seedAndGoto(page);
    page.on("dialog", d => d.accept());

    await page.evaluate(() => {
      setGroupMembers("Guard Duty", ["1401", "2401", "2402"]);
      STATE.combinedGroups = [{ name: "P1 − Guard", include: ["plt:1"], exclude: ["grp:Guard Duty"] }];
      saveCombinedGroups();
      // One group member on MC today + one NON-member on LD — the wizard's
      // status list must show only the member once the group scope is picked.
      const today = isoToDisplayDate(todayISO());
      STATE.medical.push(
        { id: 901, d4: "2401", date: today, reason: "flu", status: "MC", startDate: today, endDate: today, inCamp: false },
        { id: 902, d4: "1403", date: today, reason: "knee", status: "LD", startDate: today, endDate: today, inCamp: false }
      );
      saveLocal();
    });

    await page.evaluate(() => { openLogConductWizard(); wizSetTime("0800"); wizSetConductId("c002"); });
    await page.waitForSelector("#wiz-scope-extra");

    // Dropdown lists platoons / groups / combined groups with member counts.
    const opts = await page.$$eval("#wiz-scope-extra option", els => els.map(e => ({ v: e.value, t: e.textContent })));
    expect(opts.find(o => o.v === "plt:1").t).toContain("(3)");
    expect(opts.find(o => o.v === "grp:Guard Duty").t).toContain("(3)");
    expect(opts.find(o => o.v === "comb:P1 − Guard").t).toContain("(2)");
    expect(opts.some(o => o.v.startsWith("prog:"))).toBe(false); // pills cover programs

    // Combined scope (default) lists BOTH people on status.
    let statusD4s = await page.$$eval("#wiz-status-list .lc-wiz-status-row", els => els.map(e => e.dataset.d4));
    expect(statusD4s.sort()).toEqual(["1403", "2401"]);

    // Pick the group: status list narrows to members, Total Str = group size.
    await page.selectOption("#wiz-scope-extra", "grp:Guard Duty");
    await page.waitForSelector("#wiz-status-list");
    statusD4s = await page.$$eval("#wiz-status-list .lc-wiz-status-row", els => els.map(e => e.dataset.d4));
    expect(statusD4s).toEqual(["2401"]);
    expect(await page.$eval("#wiz-total", el => el.value)).toBe("3");

    // Save: attendance + PX detail rows carry the token in `program`.
    await page.click("#modal-body .btn-success");
    await page.waitForTimeout(150);
    const saved = await page.evaluate(() => {
      const a = STATE.attendance.find(x => x.conductId === "c002" && x.time === "0800");
      const details = STATE.conductDetail.filter(d => d.conductId === "c002" && d.time === "0800");
      return { a, details };
    });
    expect(saved.a.program).toBe("grp:Guard Duty");
    expect(saved.a.total).toBe(3);
    expect(saved.a.px).toBe(1);
    expect(saved.a.participating).toBe(2);
    expect(saved.details.map(d => ({ d4: d.d4, type: d.type, program: d.program }))).toEqual([
      { d4: "2401", type: "PX", program: "grp:Guard Duty" }
    ]);

    // Re-open in edit mode: scope + tick restore from the saved token.
    await page.evaluate(id => openLogConductWizard(id), saved.a.id);
    await page.waitForSelector("#wiz-scope-extra");
    expect(await page.$eval("#wiz-scope-extra", el => el.value)).toBe("grp:Guard Duty");
    expect(await page.$eval('.lc-wiz-status-row[data-d4="2401"] input[type=checkbox]', el => el.checked)).toBe(true);

    // Save again: the (date, time, conduct, scope) dedup tuple holds — no
    // duplicate attendance or detail rows.
    await page.click("#modal-body .btn-success");
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({
      attendance: STATE.attendance.filter(x => x.conductId === "c002" && x.time === "0800").length,
      px: STATE.conductDetail.filter(d => d.conductId === "c002" && d.time === "0800" && d.type === "PX").length
    }));
    expect(after.attendance).toBe(1);
    expect(after.px).toBe(1);
  });

  test("fallout group row expands to one detail row per member with the shared reason", async ({ page }) => {
    await seedAndGoto(page);
    page.on("dialog", d => d.accept());

    await page.evaluate(() => { openLogConductWizard(); wizSetProgram("Combined"); wizSetTime("0900"); wizSetConductId("c001"); });
    await page.waitForSelector("#wiz-scope-extra");

    // Add a Fallout group row for Platoon 2 and give it ONE shared reason.
    await page.click(`button[onclick="wizAddGroupRow('fallout')"]`);
    await page.waitForSelector("#wiz-fallout-scope-0");
    await page.selectOption("#wiz-fallout-scope-0", "plt:2");
    expect(await page.$eval("#wiz-fallout-scopehint-0", el => el.textContent)).toContain("3 members");
    expect(await page.$eval("#wiz-stat-fallout", el => el.textContent)).toBe("3");
    expect(await page.$eval("#wiz-fallout-count", el => el.textContent)).toBe("(3)");
    expect(await page.$eval("#wiz-stat-participating", el => el.textContent)).toBe("3"); // 6 − 3
    await page.fill(`.lc-wiz-bulk-row input[oninput="wizUpdateRowReason('fallout', 0, this.value)"]`, "storm cancelled leg");

    // A member added individually too is deduped, not double-counted.
    await page.click(`button[onclick="wizAddRow('fallout')"]`);
    await page.waitForSelector("#wiz-fallout-d4-1");
    await page.evaluate(() => wizUpdateRowD4("fallout", 1, "2401"));
    expect(await page.$eval("#wiz-stat-fallout", el => el.textContent)).toBe("3");

    // The same member in Report Sick triggers the overlap warning via the
    // EXPANDED member set (2401 only appears in fallout through the group).
    await page.click(`button[onclick="wizAddRow('reportSick')"]`);
    await page.waitForSelector("#wiz-reportSick-d4-0");
    await page.evaluate(() => wizUpdateRowD4("reportSick", 0, "2401"));
    expect(await page.$eval("#wiz-overlap-warning", el => el.textContent)).toContain("2401");

    await page.click("#modal-body .btn-success");
    await page.waitForTimeout(150);
    const saved = await page.evaluate(() => ({
      fallout: STATE.conductDetail
        .filter(d => d.conductId === "c001" && d.time === "0900" && d.type === "Fallout")
        .map(d => ({ d4: d.d4, reason: d.reason })).sort((a, b) => a.d4.localeCompare(b.d4)),
      reportSick: STATE.conductDetail
        .filter(d => d.conductId === "c001" && d.time === "0900" && d.type === "ReportSick")
        .map(d => d.d4),
      pending: STATE.medical.filter(m => m.status === "Pending").map(m => m.d4)
    }));
    // Group expanded to one row per Platoon 2 member, all with the group's reason.
    expect(saved.fallout).toEqual([
      { d4: "2401", reason: "storm cancelled leg" },
      { d4: "2402", reason: "storm cancelled leg" },
      { d4: "2403", reason: "storm cancelled leg" }
    ]);
    expect(saved.reportSick).toEqual(["2401"]);
    expect(saved.pending).toEqual(["2401"]); // auto-created Pending medical row
  });
});
