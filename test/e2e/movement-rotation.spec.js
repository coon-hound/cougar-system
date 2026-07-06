// Station-rotation safety on the Movement Board. Rotating groups between
// stations (Range -> Cookhouse -> Lecture -> Range) is a CYCLE: after the first
// drop, every "Pick all here" also grabs the bodies that just arrived, and no
// drop order avoids it. The fix: bodies moved during the current move-mode
// session carry a ↪ marker on their chip, and the drop bar's picked-from
// breakdown splits a location into a settled token and a "just moved" token so
// one tap sheds the arrivals and keeps the station's originals.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

function locOf(page, d4) {
  return page.evaluate((id) => movementLocationOf(id, todayISO()).location, d4);
}
function selectedIds(page) {
  return page.evaluate(() => [...document.querySelectorAll(".mv-chip.sel[data-d4]")].map(c => c.dataset.d4));
}

test.describe("Movement Board — just-moved marker + split picked-from token", () => {
  test("arrivals get ↪, pick-all splits the token, shedding keeps only the originals", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);

    // Stage Range's ORIGINAL occupants in a previous session (the fixture seeds
    // everyone at Main Body), then re-enter move mode so their markers clear.
    await page.click('button:has-text("Move Bodies")');
    await page.click('.mv-chip[data-d4="2401"]');
    await page.click('.mv-chip[data-d4="2402"]');
    await page.click('.mv-dest:has-text("Range")');
    await page.click('button:has-text("Done")');
    await page.click('button:has-text("Move Bodies")');

    // Leg 1 of a rotation: 1401 + 1402 arrive at Range.
    await page.click('.mv-chip[data-d4="1401"]');
    await page.click('.mv-chip[data-d4="1402"]');
    await page.click('.mv-dest:has-text("Range")');
    expect(await locOf(page, "1401")).toBe("Range");

    // Only the two arrivals carry the ↪ session marker — not Range's originals.
    expect(await page.locator(".mv-chip.mv-moved").count()).toBe(2);
    await expect(page.locator('.mv-chip[data-d4="1401"]')).toHaveClass(/mv-moved/);
    const originals = await page.evaluate(() =>
      [...document.querySelectorAll('.mv-card[data-loc="Range"] .mv-chip[data-d4]')]
        .filter(c => !c.classList.contains("mv-moved")).map(c => c.dataset.d4));
    expect(originals.length).toBeGreaterThan(0);

    // Leg 2: pick all at Range -> the breakdown splits settled vs just-moved.
    await page.click('.mv-card[data-loc="Range"] .mv-selall');
    await expect(page.locator("#mv-sel-from .mv-from")).toHaveCount(2);
    const movedToken = page.locator("#mv-sel-from .mv-from-moved");
    await expect(movedToken).toHaveText(`✕ ↪ Range · 2 just moved`);

    // One tap sheds the arrivals; only the station's originals stay picked.
    await movedToken.click();
    const sel = await selectedIds(page);
    expect(sel.sort()).toEqual(originals.sort());
    expect(sel).not.toContain("1401");

    // The drop moves only the originals — the arrivals stay put at Range.
    await page.click('.mv-dest:has-text("Cookhouse")');
    expect(await locOf(page, "1401")).toBe("Range");
    expect(await locOf(page, "1402")).toBe("Range");
    for (const d4 of originals) expect(await locOf(page, d4)).toBe("Cookhouse");
  });

  test("undo removes the ↪ marker, redo restores it", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);
    await page.click('button:has-text("Move Bodies")');

    await page.click('.mv-chip[data-d4="1403"]');
    await page.click('.mv-dest:has-text("Range")');
    await expect(page.locator('.mv-chip[data-d4="1403"]')).toHaveClass(/mv-moved/);

    // Undo puts him back — he is no longer a session arrival anywhere.
    await page.click(".mv-movebar .mv-undo");
    await expect(page.locator('.mv-chip[data-d4="1403"]')).not.toHaveClass(/mv-moved/);

    // Redo re-applies the move — the marker is truthful again.
    await page.click(".mv-movebar .mv-undo");
    expect(await locOf(page, "1403")).toBe("Range");
    await expect(page.locator('.mv-chip[data-d4="1403"]')).toHaveClass(/mv-moved/);
  });

  test("markers are session-scoped: re-entering move mode starts clean", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);
    await page.click('button:has-text("Move Bodies")');
    await page.click('.mv-chip[data-d4="1401"]');
    await page.click('.mv-dest:has-text("Cookhouse")');
    expect(await page.locator(".mv-chip.mv-moved").count()).toBe(1);

    await page.click('button:has-text("Done")');
    await page.click('button:has-text("Move Bodies")');
    expect(await page.locator(".mv-chip.mv-moved").count()).toBe(0);
  });

  test("a full cyclic rotation lands every group at the next station", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);

    // Stage two stations, then swap them — a 2-cycle, the minimal case with no
    // safe drop order. Staged in a previous session so no ↪ markers linger.
    await page.click('button:has-text("Move Bodies")');
    await page.click('.mv-chip[data-d4="1401"]');
    await page.click('.mv-chip[data-d4="1402"]');
    await page.click('.mv-dest:has-text("Range")');
    await page.click('.mv-chip[data-d4="2401"]');
    await page.click('.mv-chip[data-d4="2402"]');
    await page.click('.mv-dest:has-text("Cookhouse")');
    await page.click('button:has-text("Done")');
    await page.click('button:has-text("Move Bodies")');
    const groups = { range: ["1401", "1402"], cook: ["2401", "2402"] };

    // Leg 1: Range -> Cookhouse (whole card).
    await page.click('.mv-card[data-loc="Range"] .mv-selall');
    await page.click('.mv-dest:has-text("Cookhouse")');
    // Leg 2: pick all at Cookhouse, shed the arrivals, drop at Range.
    await page.click('.mv-card[data-loc="Cookhouse"] .mv-selall');
    await page.click("#mv-sel-from .mv-from-moved");
    await page.click('.mv-dest:has-text("Range")');

    for (const d4 of groups.range) expect(await locOf(page, d4)).toBe("Cookhouse");
    for (const d4 of groups.cook) expect(await locOf(page, d4)).toBe("Range");
  });
});
