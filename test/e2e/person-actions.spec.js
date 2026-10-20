// The person sheet starts the forms people open right after a lookup, with the
// man already chosen (usage data, Sep 2026: 619 person opens, then 251 picks of
// a soldier in the next form's 4D dropdown).
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("phone: Report Sick and Appointment open from the sheet with the man chosen", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAndGoto(page);
  const d4 = await page.evaluate(() => STATE.roster.find((r) => r.role !== "Commander").id);

  await page.evaluate((id) => openPerson(id), d4);
  const acts = page.locator("#modal-overlay .person-acts .quick-act");
  await expect(acts).toHaveText(["✚Report Sick", "◷Appointment"]);
  await page.waitForTimeout(500); // let the sheet finish sliding up
  // The sticky sheet header used to cover the first 6px of the body, cutting
  // through this rank / 4D line.
  const gap = await page.evaluate(() =>
    document.querySelector("#modal-body > *").getBoundingClientRect().top - document.querySelector(".modal-header").getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  await expect(page.locator("#modal-body")).not.toContainText("undefined");
  await page.screenshot({ path: "test-results/person-actions-sheet.png" });

  await acts.nth(0).click();
  await expect(page.locator("#modal-overlay")).toContainText("Log Report Sick");
  await expect(page.locator("#f-d4")).toHaveValue(d4);
  // And it saves against him, end to end.
  await page.fill("#f-reason", "Fever");
  await page.locator("#f-status").selectOption("Pending");
  const before = await page.evaluate((id) => STATE.medical.filter((m) => m.d4 === id).length, d4);
  await page.locator('#modal-overlay button[type="submit"]').click();
  await expect.poll(() => page.evaluate((id) => STATE.medical.filter((m) => m.d4 === id).length, d4)).toBe(before + 1);
  await page.evaluate(() => closeModal());

  await page.evaluate((id) => openPerson(id), d4);
  await acts.nth(1).click();
  await expect(page.locator("#modal-overlay")).toContainText("Book Appointment");
  await expect(page.locator("#f-d4")).toHaveValue(d4);
  await page.evaluate(() => closeModal());

  // A plain new entry still starts blank.
  await page.evaluate(() => openMedicalForm());
  await expect(page.locator("#f-d4")).toHaveValue("");
  await page.evaluate(() => closeModal());
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
