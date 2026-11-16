// Feature spec for the Report Sick form's status options: the Permanent tick,
// live / blank firing as two excuses, and a re-typed custom status filing under
// the existing one.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

async function fillBasics(page) {
  await page.evaluate(() => openMedicalForm(null, { d4: "1401" }));
  await page.fill("#f-reason", "Eczema");
}

const recordsFor = (page, d4) => page.evaluate(d => STATE.medical.filter(m => m.d4 === d)
  .map(m => ({ status: m.status, endDate: m.endDate, permanent: m.permanent })), d4);

test.describe("Report Sick status options", () => {
  test("Permanent locks the end date and saves a status with no end", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await seedAndGoto(page);
    await fillBasics(page);

    await page.selectOption("#f-status", "Excuse Uniform");
    await page.fill("#f-end", "2026-12-31");
    await page.check("#f-permanent");
    await expect(page.locator("#f-end")).toBeDisabled();
    await expect(page.locator("#f-end")).toHaveValue("");
    await page.click('#modal button[type="submit"], .modal button[type="submit"]');

    const recs = await recordsFor(page, "1401");
    expect(recs).toContainEqual({ status: "Excuse Uniform", endDate: "", permanent: true });

    // Active today, and the Medical table says Permanent in the End column.
    expect(await page.evaluate(() => currentMedicalEffectiveAll(todayISO())
      .find(e => e.d4 === "1401")?.statuses.map(s => s.tag))).toContain("Excuse Uniform");
    await page.click('.nav-btn[data-nav="medical"]');
    const row = page.locator("table tbody tr", { hasText: "1401" }).filter({ hasText: "Eczema" }).first();
    await expect(row).toContainText("Permanent");

    // Editing it keeps the tick and the locked end date.
    await page.evaluate(() => openMedicalForm(STATE.medical.find(m => m.d4 === "1401" && m.permanent).id));
    await expect(page.locator("#f-permanent")).toBeChecked();
    await expect(page.locator("#f-end")).toBeDisabled();

    expect(errors, "no page errors: " + errors.join("; ")).toEqual([]);
  });

  test("an MC cannot be permanent", async ({ page }) => {
    await seedAndGoto(page);
    await fillBasics(page);
    await page.selectOption("#f-status", "MC");
    await page.check("#f-permanent");
    let alerted = "";
    page.once("dialog", d => { alerted = d.message(); d.accept(); });
    await page.click('.modal button[type="submit"]');
    expect(alerted).toContain("cannot be permanent");
    expect(await recordsFor(page, "1401")).not.toContainEqual(expect.objectContaining({ status: "MC", permanent: true }));
  });

  test("live and blank firing are two excuses, and a combined one saves as both", async ({ page }) => {
    await seedAndGoto(page);
    await fillBasics(page);
    for (const s of ["Excuse Live Firing", "Excuse Blank Firing"]) {
      await expect(page.locator("#f-status option", { hasText: s })).toHaveCount(1);
    }
    await page.selectOption("#f-status", "__new__");
    await page.fill("#f-custom-name", "excuse live/blank firing");
    await page.fill("#f-end", "2026-12-31");
    await page.click('.modal button[type="submit"]');

    const statuses = (await recordsFor(page, "1401")).map(r => r.status);
    expect(statuses).toContain("Excuse Live Firing");
    expect(statuses).toContain("Excuse Blank Firing");
    expect(await page.evaluate(() => STATE.customStatuses.map(c => c.name))).not.toContain("excuse live/blank firing");
  });

  test("a custom status saved on one phone is offered on another after sync", async ({ browser }) => {
    // Phone A logs a new custom status and saves it for reuse.
    const a = await browser.newPage();
    await seedAndGoto(a);
    await fillBasics(a);
    await a.selectOption("#f-status", "__new__");
    await a.fill("#f-custom-name", "Excuse Helmet");
    await a.check("#f-custom-participates");
    await a.fill("#f-end", "2026-12-31");
    await a.click('.modal button[type="submit"]');
    const synced = await a.evaluate(() => STATE.medical.filter(m => m.status === "Excuse Helmet"));
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ participates: true, oneOff: false });

    // Phone B has never seen it locally; it only receives the medical rows.
    const b = await browser.newPage();
    await seedAndGoto(b);
    expect(await b.evaluate(() => STATE.customStatuses.length)).toBe(0);
    await b.evaluate(rows => { STATE.medical = normalizeMedical(STATE.medical.concat(rows)); render(); }, synced);
    await b.evaluate(() => openMedicalForm());
    const opt = b.locator('#f-status optgroup[label="Custom"] option', { hasText: "Excuse Helmet" });
    await expect(opt).toHaveCount(1);
    await expect(opt).toContainText("(participates)");
    await a.close(); await b.close();
  });

  test("a re-typed custom status files under the existing name", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => { STATE.customStatuses = [{ name: "Excuse Boots", participates: false }]; saveCustomStatuses(); });
    await fillBasics(page);
    await page.selectOption("#f-status", "__new__");
    await page.fill("#f-custom-name", "excused boot");
    await page.fill("#f-end", "2026-12-31");
    await page.click('.modal button[type="submit"]');

    expect((await recordsFor(page, "1401")).map(r => r.status)).toContain("Excuse Boots");
    expect(await page.evaluate(() => STATE.customStatuses.map(c => c.name))).toEqual(["Excuse Boots"]);
  });
});
