// Feature spec: every person picker has a type-to-find box above it.
//
// Drives the REAL Book Appointment form (rosterSelect). Typing narrows the
// dropdown, a single match is picked (and the form's onchange sees it), Enter
// picks the first match without submitting, and the pick survives a filter
// that would otherwise hide it.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const optionValues = (page) =>
  page.$$eval("#f-d4 option", (els) => els.map((e) => e.value).filter(Boolean));

test.describe("type to find a person", () => {
  test("search narrows the appointment picker and picks a single match", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await seedAndGoto(page);
    await page.evaluate(() => openAppointmentForm(""));
    const q = page.locator("#f-d4-q");
    await expect(q).toBeVisible();
    const all = await optionValues(page);
    expect(all.length).toBeGreaterThan(5);

    // Name words, any order, any case.
    await q.fill("one alpha");
    expect(await optionValues(page)).toEqual(["1401"]);
    await expect(page.locator("#f-d4")).toHaveValue("1401");

    // A 4D prefix; the earlier pick stays listed so it is never lost silently.
    await q.fill("240");
    expect(await optionValues(page)).toEqual(["1401", "2401", "2402", "2403"]);
    await expect(page.locator("#f-d4")).toHaveValue("1401");

    // Enter picks the first match and does not submit the form.
    await q.fill("bravo");
    await q.press("Enter");
    await expect(page.locator("#f-d4")).toHaveValue("2401");
    await expect(page.locator("#f-d4-q")).toBeVisible();

    // Nobody matches: says so; clearing brings everyone back.
    await q.fill("zzz");
    await expect(page.locator("#f-d4 option").first()).toHaveText("No one found");
    await q.fill("");
    expect(await optionValues(page)).toEqual(all);
    expect(errors).toEqual([]);
  });

  test("a single match fires the picker's onchange (Book Out reason prefill path)", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      window.__changed = [];
      openBookOutForm({});
      document.getElementById("f-bo-d4").addEventListener("change", (e) => window.__changed.push(e.target.value));
    });
    const scope = page.locator("#f-bo-scope");
    if (await scope.count()) {
      const one = await scope.locator("option").evaluateAll( (os) => (os.find((o) => /one person/i.test(o.text)) || {}).value);
      if (one !== undefined) await scope.selectOption(one);
    }
    await page.locator("#f-bo-d4-q").fill("bravo two");
    await expect(page.locator("#f-bo-d4")).toHaveValue("2402");
    expect(await page.evaluate(() => window.__changed)).toEqual(["2402"]);
  });
});
