// Per-conduct WhatsApp chat format (buildConductChatFormat). Report-sick
// personnel no longer get their own section: they fold into FALLOUT with a
// "(report sick)" tag on the reason, the header "Report sick:" line is gone,
// and the Fallout count folds them in. "Pending" (awaiting-MO) never prints as
// a status. The wizard UI keeps its separate Report Sick / Fallout inputs — only
// the generated message changed.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Conduct chat format: report-sick folds into fallout", () => {
  test("folds report-sick into FALLOUT, tags the reason, drops the section + header line, hides Pending", async ({ page }) => {
    await seedAndGoto(page);

    const text = await page.evaluate(() => {
      const today = isoToDisplayDate(todayISO());
      // A STATUS person whose only active medical row is Pending — the auto-created
      // report-sick row must NOT surface as "Status: Pending" in the STATUS block.
      STATE.medical.push(
        { id: 950, d4: "1401", date: today, reason: "knee", status: "Pending", startDate: today, endDate: "" }
      );
      const att = { id: 9001, date: today, time: "0900", conductId: "c001", program: "Combined", total: 6, participating: 3, lms: 0, px: 1, fallout: 1, remarks: "" };
      STATE.attendance.push(att);
      STATE.conductDetail.push(
        { id: 9101, date: today, time: "0900", conductId: "c001", program: "Combined", d4: "1401", type: "PX", reason: "knee" },
        { id: 9102, date: today, time: "0900", conductId: "c001", program: "Combined", d4: "2401", type: "Fallout", reason: "cramp" },
        { id: 9103, date: today, time: "0900", conductId: "c001", program: "Combined", d4: "2402", type: "ReportSick", reason: "sprain" },
        { id: 9104, date: today, time: "0900", conductId: "c001", program: "Combined", d4: "2403", type: "ReportSick", reason: "" }
      );
      return buildConductChatFormat(9001);
    });

    // No separate report-sick section, and no "Report sick:" header line.
    expect(text).not.toContain("REPORT SICK");
    expect(text).not.toMatch(/Report sick:/i);

    // Header Fallout count folds in the two report-sick people: 1 fallout + 2.
    expect(text).toMatch(/\nFallout: 03/);

    // FALLOUT section lists all three; report-sick reasons carry the tag,
    // an empty reason becomes just "(report sick)".
    expect(text).toContain("FALLOUT: 03");
    expect(text).toContain("Reason: cramp");
    expect(text).toContain("Reason: sprain (report sick)");
    expect(text).toContain("Reason: (report sick)");

    // Pending is never surfaced as a status anywhere in the message.
    expect(text).not.toContain("Status: Pending");
  });
});
