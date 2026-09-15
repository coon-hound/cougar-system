// An enlistee's rank is read off the Roster, not printed as a constant.
//
// The bug this pins: "REC" was written literally into the three places that
// format a man's name, so a cohort promoted to PTE on posting into unit
// training still paraded as recruits — against a battalion nominal roll that
// said PTE. It is the kind of error nobody notices from inside the app,
// because every surface agreed with every other surface. It only shows up when
// the parade state is read next to someone else's document.
//
// Rank moves; the app has to follow it. These run in a real browser, through
// the real profile card and the real parade-state generator.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// Promote one man in the cached roster and re-render, which is exactly what a
// pull carrying his new rank does. Returns his 4D.
async function promote(page, d4, rank) {
  await page.evaluate(([id, rk]) => {
    const r = STATE.roster.find((x) => x.id === id);
    r.rank = rk;
    render();
  }, [d4, rank]);
  return d4;
}

test.describe("rank comes from the roster", () => {
  test("the profile card shows the rank the roster carries", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await seedAndGoto(page);

    // Baseline: the fixture says REC, so the card says REC.
    await page.evaluate(() => openPerson("1401"));
    await expect(page.locator("#modal-body")).toContainText("REC · 1401");
    await page.evaluate(() => closeModal());

    // Promote him and the card follows, without any other change.
    await promote(page, "1401", "PTE");
    await page.evaluate(() => openPerson("1401"));
    await expect(page.locator("#modal-body")).toContainText("PTE · 1401");
    await expect(page.locator("#modal-body")).not.toContainText("REC · 1401");
    await page.evaluate(() => closeModal());

    expect(errors).toEqual([]);
  });

  test("a promotion reaches the parade state, one man at a time", async ({ page }) => {
    await seedAndGoto(page);

    // The parade state only NAMES a man who has a record, so give two of them
    // one. 4Ds go in padD4 form ("1401", not the fixture's "C1401"): rows
    // pushed straight into STATE skip the normalizers, and a mis-keyed row
    // orphans silently rather than failing.
    const txt = await page.evaluate(() => {
      const today = todayISO();
      // Dates go in the DISPLAY form the records actually carry
      // ("15 Sep 2026"); a bare ISO string here matches nothing and the man
      // silently stays in strength instead of appearing on a line.
      const shown = isoToDisplayDate(today);
      for (const d4 of ["1401", "1402"]) {
        STATE.medical.push({
          id: "m-" + d4, d4, status: "MC", reason: "Flu",
          startDate: shown, endDate: shown, inCamp: false, location: "",
        });
      }
      STATE.roster.find((r) => r.id === "1401").rank = "PTE";   // promoted
      STATE.roster.find((r) => r.id === "1402").rank = "REC";   // not
      return generateParadeStateText("FP", today, "0730");
    });

    expect(txt).toContain("PTE ALPHA ONE C1401");
    // His platoon-mate was not promoted and must be untouched — the rank is
    // read per man, not once for the whole parade.
    expect(txt).toContain("REC ALPHA TWO C1402");
    expect(txt).not.toContain("REC ALPHA ONE");
  });

  test("a commander is still rank + name, never a 00xx id", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => openPerson("0001"));
    const body = page.locator("#modal-body");
    await expect(body).toContainText("3SG");
    await expect(body).toContainText("Commander");
    await expect(body).not.toContainText("0001 —");
  });

  test("a blank rank still falls back to REC", async ({ page }) => {
    await seedAndGoto(page);
    await promote(page, "1402", "");
    await page.evaluate(() => openPerson("1402"));
    // Every row looked like this before the column carried anything, so the
    // fallback is what stops this change blanking rank for whole platoons.
    await expect(page.locator("#modal-body")).toContainText("REC · 1402");
  });

  test("the roster table still renders with ranks present", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await seedAndGoto(page);
    await page.locator('.nav-btn[data-nav="roster"]').dispatchEvent("click");
    await expect(page.locator("#content")).toContainText("ALPHA ONE");
    expect(errors).toEqual([]);
    await page.screenshot({ path: "test-results/rank-from-roster.png", fullPage: true });
  });
});
