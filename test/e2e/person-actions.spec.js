// The person card starts the forms people open right after a lookup, with the
// man already chosen (usage_daily, Sep - Oct 2026: openPerson 1,476 taps, and
// medical entry always began from select#f-d4, 439 taps).
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("phone: Report sick, Appointment and Leave open from the card with the man chosen", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAndGoto(page);
  const d4 = await page.evaluate(() => STATE.roster.find((r) => r.role !== "Commander").id);

  await page.evaluate((id) => openPerson(id), d4);
  const body = page.locator("#modal-body");
  await expect(body.locator("button", { hasText: "Report sick" })).toBeVisible();
  await page.waitForTimeout(400); // let the sheet finish sliding up
  await page.screenshot({ path: "test-results/person-actions-sheet.png" });

  await body.locator("button", { hasText: "Report sick" }).click();
  await expect(page.locator("#modal-title")).toHaveText("Log Report Sick");
  await expect(page.locator("#f-d4")).toHaveValue(d4);
  // And it saves against him, end to end.
  await page.fill("#f-reason", "Fever");
  await page.locator("#f-status").selectOption("Pending");
  const before = await page.evaluate((id) => STATE.medical.filter((m) => m.d4 === id).length, d4);
  await page.locator('#modal-overlay button[type="submit"]').click();
  await expect.poll(() => page.evaluate((id) => STATE.medical.filter((m) => m.d4 === id).length, d4)).toBe(before + 1);
  await page.evaluate(() => closeModal());

  await page.evaluate((id) => openPerson(id), d4);
  await body.locator("button", { hasText: "Appointment" }).click();
  await expect(page.locator("#modal-title")).toHaveText("Book Appointment");
  await expect(page.locator("#f-d4")).toHaveValue(d4);
  await page.evaluate(() => closeModal());

  await page.evaluate((id) => openPerson(id), d4);
  await body.locator("button", { hasText: "Leave" }).click();
  await expect(page.locator("#modal-title")).toHaveText("Book Out of Camp");
  await expect(page.locator("#f-bo-mode")).toHaveValue("range");
  await expect(page.locator("#f-bo-submit")).toContainText("Log leave");
  await page.evaluate(() => closeModal());

  // A plain new entry still starts blank.
  await page.evaluate(() => openMedicalForm());
  await expect(page.locator("#f-d4")).toHaveValue("");
  await page.evaluate(() => closeModal());
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
