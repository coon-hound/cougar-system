// Feature spec: every person picker is ONE box that is both a search and a
// dropdown.
//
// Drives the REAL Book Appointment form (rosterSelect). Tapping the box lists
// everyone; typing narrows that same list; tapping a name picks him; a single
// match is picked (and the form's onchange sees it); Enter picks the first
// match without submitting; leaving the box with half-typed text puts the
// pick's name back. The hidden <select> stays the real field.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const listed = (page, id) =>
  page.$$eval(`#${id}-menu [role=option]`, (els) => els.map((e) => e.dataset.v));

test.describe("one box to pick a person", () => {
  test("search and dropdown are the same box in the appointment form", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await seedAndGoto(page);
    await page.evaluate(() => openAppointmentForm(""));
    const q = page.locator("#f-d4-q");
    const menu = page.locator("#f-d4-menu");
    await expect(q).toBeVisible();
    // No second control: the real select is hidden.
    await expect(page.locator("#f-d4")).toBeHidden();
    await expect(menu).toBeHidden();

    // Tap: the whole list drops down.
    await q.click();
    await expect(menu).toBeVisible();
    const all = await listed(page, "f-d4");
    expect(all.length).toBeGreaterThan(5);

    // Tap a name: picked, the box shows him, the list closes.
    await menu.locator('[data-v="2403"]').click();
    await expect(page.locator("#f-d4")).toHaveValue("2403");
    await expect(menu).toBeHidden();
    await expect(q).toHaveValue(/^2403 /);

    // Type in the same box: name words, any order, any case; one match is picked.
    await q.click();
    await q.fill("one alpha");
    await expect(menu).toBeVisible();
    expect(await listed(page, "f-d4")).toEqual(["1401"]);
    await expect(page.locator("#f-d4")).toHaveValue("1401");

    // A 4D prefix lists the matches; the pick stands until another is made.
    await q.fill("240");
    expect(await listed(page, "f-d4")).toEqual(["2401", "2402", "2403"]);
    await expect(page.locator("#f-d4")).toHaveValue("1401");

    // Enter picks the first match and does not submit the form.
    await q.fill("bravo");
    await q.press("Enter");
    await expect(page.locator("#f-d4")).toHaveValue("2401");
    await expect(q).toBeVisible();
    await expect(menu).toBeHidden();

    // Nobody matches: says so; leaving the box puts the pick's name back.
    await q.click();
    await q.fill("zzz");
    await expect(menu).toContainText("No one found");
    await page.locator(".modal h3").first().click();
    await expect(q).toHaveValue(/^2401 /);
    await expect(page.locator("#f-d4")).toHaveValue("2401");

    // Reopening lists everyone again, not just the current pick.
    await q.click();
    expect(await listed(page, "f-d4")).toEqual(all);
    expect(errors).toEqual([]);
  });

  test("an empty box blocks a required form, and clearing it clears the pick", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => openAppointmentForm("", { d4: "2402" }));
    const q = page.locator("#f-d4-q");
    await expect(q).toHaveValue(/^2402 /);
    await q.fill("");
    await page.locator(".modal h3").first().click();
    await expect(page.locator("#f-d4")).toHaveValue("");
    expect(await q.evaluate((el) => el.validity.valueMissing)).toBe(true);
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
