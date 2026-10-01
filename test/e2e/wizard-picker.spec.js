// Conduct wizard: add several fall-outs from one checklist.
//
// One row at a time cost three taps a man (+ Add, open the row's dropdown,
// pick) and the wizard averaged ~35 taps a conduct (usage data, Sep 2026:
// 128 wizAddRow, 105 fall-out picks). The picker lists the conduct's scope:
// tick everyone, optionally give one reason, add them all.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("phone: tick several fall-outs, one shared reason, saved per man", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAndGoto(page);
  await page.evaluate(() => { openLogConductWizard(); wizSetProgram("Combined"); wizSetTime("0900"); wizSetConductId("c001"); });

  let taps = 0;
  const tap = async (locator) => { taps += 1; await locator.click(); };

  await tap(page.locator(`button[onclick="wizOpenPicker('fallout')"]`).first());
  const pick = page.locator("#wiz-pick");
  await expect(pick).toBeVisible();
  // The whole scope, recruits only, by 4D.
  await expect(pick.locator(".wiz-pick-row .mono")).toHaveText(["1401", "1402", "1403", "2401", "2402", "2403"]);

  // Filter narrows without re-rendering (the field keeps focus).
  await page.locator("#wiz-pick-q").fill("14");
  await expect(pick.locator(".wiz-pick-row:not([hidden]) .mono")).toHaveText(["1401", "1402", "1403"]);
  await expect(page.locator("#wiz-pick-q")).toBeFocused();

  await expect(page.locator("#wiz-pick-add")).toBeDisabled();
  await tap(pick.locator(".wiz-pick-row", { hasText: "1401" }));
  await tap(pick.locator(".wiz-pick-row", { hasText: "1402" }));
  await expect(page.locator("#wiz-pick-add")).toHaveText("Add 2");
  await page.locator("#wiz-pick-reason").fill("cramps");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/wizard-picker-open.png" });
  await tap(page.locator("#wiz-pick-add"));

  await expect(page.locator("#wiz-pick")).toHaveCount(0);
  expect(await page.$eval("#wiz-stat-fallout", (el) => el.textContent)).toBe("2");
  expect(await page.$eval("#wiz-fallout-count", (el) => el.textContent)).toBe("(2)");
  // Two men out, four taps. One row at a time was at least six.
  expect(taps).toBe(4);

  // Already-listed men are not offered again.
  await page.locator(`button[onclick="wizOpenPicker('fallout')"]`).first().click();
  await expect(page.locator("#wiz-pick .wiz-pick-row .mono")).toHaveText(["1403", "2401", "2402", "2403"]);
  await page.locator("#wiz-pick .btn", { hasText: "Cancel" }).click();
  await expect(page.locator("#wiz-pick")).toHaveCount(0);

  await page.click("#modal-body .btn-success");
  await expect.poll(() => page.evaluate(() => STATE.conductDetail
    .filter((d) => d.conductId === "c001" && d.time === "0900" && d.type === "Fallout")
    .map((d) => `${d.d4}:${d.reason}`).sort())).toEqual(["1401:cramps", "1402:cramps"]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("phone: typing a 4D or a name in a person picker narrows it, and a unique match is chosen", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAndGoto(page);

  await page.evaluate(() => openMedicalForm());
  const q = page.locator("#modal-overlay .d4-pick-q");
  const sel = page.locator("#f-d4");
  const all = await sel.locator("option").count();

  await q.fill("14");
  await expect(sel.locator("option")).toHaveText(["Select...", "1401 ALPHA ONE", "1402 ALPHA TWO", "1403 ALPHA THREE"]);
  await expect(sel).toHaveValue("");

  // A unique match is selected outright: no dropdown at all.
  await q.fill("1402");
  await expect(sel).toHaveValue("1402");
  await q.fill("bravo two");
  await expect(sel).toHaveValue("2402");

  await q.fill("zzz");
  await expect(sel.locator("option")).toHaveText(["No match"]);
  await expect(sel).toHaveValue("");

  // Clearing restores the whole list.
  await q.fill("");
  await expect(sel.locator("option")).toHaveCount(all);
  await page.screenshot({ path: "test-results/wizard-picker-typeahead.png" });
  await page.evaluate(() => closeModal());

  // A change handler on the select still runs for a typed match: Book Out
  // reacts to the person chosen.
  await page.evaluate(() => {
    window.__boChanged = 0;
    const orig = window.onBookOutPersonChange;
    window.onBookOutPersonChange = function () { window.__boChanged += 1; return orig.apply(this, arguments); };
    openBookOutForm();
    window.__boChanged = 0; // the form runs it once itself while opening
  });
  await page.locator("#f-bo-person-wrap .d4-pick-q").fill("1403");
  await expect(page.locator("#f-bo-d4")).toHaveValue("1403");
  expect(await page.evaluate(() => window.__boChanged)).toBe(1);
  await page.evaluate(() => closeModal());
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
