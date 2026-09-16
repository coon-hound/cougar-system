// Feature spec: the command body reads highest rank first; the men keep 4D order.
//
// Drives the REAL Roster screen and the REAL person pickers. The demo fixture
// is six RECs and one 3SG, which cannot tell a rank sort from a 4D sort, so
// each test seeds a mixed command body into the cached roster at runtime (the
// same thing a pull carrying new ranks does) and re-renders. Nothing here
// touches the shared fixture.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// CPT > 2LT > SSG > 3SG (the fixture's own commander) > CFC > REC > blank.
// Deliberately seeded in scrambled order, and 0005 has NO rank at all: an
// unknown rank must still appear, at the bottom, and must not throw.
const MIXED = [
  { id: "0005", name: "COMD UNKNOWN", role: "Commander", rank: "" },
  { id: "0003", name: "COMD WONG", role: "Commander", rank: "2LT" },
  { id: "0004", name: "COMD SIM", role: "Commander", rank: "SSG" },
  { id: "0002", name: "COMD LEE", role: "Commander", rank: "CPT" },
];

// Roster order after seeding: the command body senior-first (the blank-rank
// commander last of THEM, but still ahead of the men), then every enlistee in
// 4D order regardless of the rank he carries.
const EXPECTED = ["0002", "0003", "0004", "0001", "0005",
                  "1401", "1402", "1403", "2401", "2402", "2403"];

async function seedMixed(page) {
  await page.evaluate((extra) => {
    STATE.roster.push(...extra);
    // One man given a higher rank than the rest. He must NOT move: rank
    // ordering stops at the command body, and 1401 is already first by 4D.
    STATE.roster.find((r) => r.id === "1401").rank = "CFC";
    saveLocal();
    render();
  }, MIXED);
}

// The 4D of every row of the Roster table, top to bottom.
const rosterIds = (page) =>
  page.$$eval("#content table tbody tr", (rows) =>
    rows.map((r) => ((r.getAttribute("onclick") || "").match(/openPerson\('([^']+)'\)/) || [])[1]));

// The values of a person <select>, minus the "Select..." placeholder.
const optionValues = (page, sel) =>
  page.$$eval(`${sel} option`, (els) => els.map((e) => e.value).filter(Boolean));

test.describe("people list by rank, highest first", () => {
  test("the Roster lists the command body by rank, then the men by 4D", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await seedAndGoto(page);
    await seedMixed(page);
    await page.click('.nav-btn[data-nav="roster"]');

    expect(await rosterIds(page)).toEqual(EXPECTED);

    // The point of this assertion: the men read in 4D order, and the promoted
    // CFC (1401) sits where his 4D puts him rather than at the head of them.
    const men = (await rosterIds(page)).slice(5);
    expect(men).toEqual([...men].sort());

    await page.screenshot({ path: "test-results/rank-ordering-roster.png", fullPage: true });
    expect(errors).toEqual([]);
  });

  test("a person dropdown lists the command body first", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await seedAndGoto(page);
    await seedMixed(page);

    // The shared picker (rosterSelect) behind Medical / IPPT / Book Out /
    // Leave / Log Conduct. Asserting it once covers all of them.
    await page.evaluate(() => openMedicalForm());
    await expect(page.locator("#f-d4")).toBeVisible();
    expect(await optionValues(page, "#f-d4")).toEqual(EXPECTED);

    // The label still reads "rank name" for a commander, so the order is
    // legible on screen and not just in the DOM.
    const labels = await page.$$eval("#f-d4 option", (els) =>
      els.map((e) => e.textContent.trim()).filter((t) => t !== "Select..."));
    expect(labels[0]).toBe("CPT COMD LEE");
    // The blank-rank commander is last of the command body, not last overall.
    expect(labels[4]).toBe("COMD UNKNOWN");

    await page.evaluate(() => closeModal());
    expect(errors).toEqual([]);
  });

  test("the duty pickers are senior-first too", async ({ page }) => {
    await seedAndGoto(page);
    await seedMixed(page);

    // FP/LP duty roles (CDO/CDS/COS/PDS) pick from the command body only.
    await page.evaluate(() => openReportModal("FP"));
    await expect(page.locator("#duty-section select").first()).toBeVisible();
    const opts = await page.$$eval("#duty-section select", (sels) =>
      [...sels[0].options].map((o) => o.value).filter(Boolean));
    expect(opts).toEqual(["0002", "0003", "0004", "0001", "0005"]);
    await page.evaluate(() => closeModal());
  });

  test("phone: the order holds at 390px, in the Roster and in a dropdown", async ({ page }) => {
    // Phone-first is the primary constraint, so the real check is on a phone
    // screen: the Roster is a horizontally scrolling table and the picker is a
    // full-width select inside the modal.
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAndGoto(page);
    await seedMixed(page);
    // Navigate the way a phone does: the sidebar is behind the ☰ toggle.
    await page.click("#mobile-nav-toggle");
    await page.click('.nav-btn[data-nav="roster"]');

    expect(await rosterIds(page)).toEqual(EXPECTED);
    // Nothing overflows the phone: the table scrolls inside its wrapper.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "test-results/rank-ordering-roster-390.png", fullPage: true });

    await page.evaluate(() => openMedicalForm());
    await expect(page.locator("#f-d4")).toBeVisible();
    expect(await optionValues(page, "#f-d4")).toEqual(EXPECTED);
    await page.screenshot({ path: "test-results/rank-ordering-picker-390.png", fullPage: true });
  });
});
