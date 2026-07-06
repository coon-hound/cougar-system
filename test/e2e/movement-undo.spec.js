// Undo-last-move safety net on the Movement Board. In move mode every location
// card's whole surface is a drop target (mvCardDrop), so a scroll-tap misfire
// with a selection active silently commits the entire pick to that card. The
// ↩ Undo button restores each body to its own PREVIOUS location (a mixed-source
// selection goes back to its several sources in one tap), and tapping again
// redoes the move. Covers every mutation path through moveToLocation.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

function locOf(page, d4) {
  return page.evaluate((id) => movementLocationOf(id, todayISO()).location, d4);
}

test.describe("Movement Board — undo last move", () => {
  test("misfired card drop of a mixed-source pick restores per-body, then redoes", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);

    // No move yet -> no undo affordance anywhere.
    expect(await page.locator(".mv-undo").count()).toBe(0);
    expect(await page.locator('button:has-text("Undo last move")').count()).toBe(0);

    // Stage: 1401+1402 to Range, so the next pick spans two source locations.
    await page.click('button:has-text("Move Bodies")');
    await page.click('.mv-chip[data-d4="1401"]');
    await page.click('.mv-chip[data-d4="1402"]');
    await page.click('.mv-dest:has-text("Range")');
    expect(await locOf(page, "1401")).toBe("Range");

    // Mixed-source pick: 1401 (Range) + 1403 (Main Body). The misfire: a tap
    // lands on the Cookhouse card body — the drop commits silently.
    await page.click('.mv-chip[data-d4="1401"]');
    await page.click('.mv-chip[data-d4="1403"]');
    await page.click('.mv-card[data-loc="Cookhouse"] .mv-pips');
    expect(await locOf(page, "1401")).toBe("Cookhouse");
    expect(await locOf(page, "1403")).toBe("Cookhouse");

    // One tap on ↩ Undo in the drop bar: each body returns to its OWN source
    // (1401 -> Range, 1403 -> Main Body), not to a single bucket.
    const undo = page.locator(".mv-movebar .mv-undo");
    await expect(undo).toContainText("↩ Undo last move (2 → Cookhouse)");
    await undo.click();
    expect(await locOf(page, "1401")).toBe("Range");
    expect(await locOf(page, "1403")).toBe("Main Body");

    // The button flips to redo; tapping it re-applies the same move.
    await expect(page.locator(".mv-movebar .mv-undo")).toContainText("↻ Redo last move (2 → Cookhouse)");
    await page.click(".mv-movebar .mv-undo");
    expect(await locOf(page, "1401")).toBe("Cookhouse");
    expect(await locOf(page, "1403")).toBe("Cookhouse");

    // Undo again (leave the fixed state), exit move mode: the safety net is
    // still offered in view mode (mistakes get noticed after Done too) — as a
    // redo now, since the last action was an undo.
    await page.click(".mv-movebar .mv-undo");
    await page.click('button:has-text("Done")');
    await expect(page.locator('.mv-actions button:has-text("Redo last move")')).toBeVisible();

    // Recall all goes through moveToLocation too — undo restores the spread.
    page.once("dialog", d => d.accept());
    await page.click('button:has-text("Recall all")');
    expect(await locOf(page, "1401")).toBe("Main Body");
    expect(await locOf(page, "1402")).toBe("Main Body");
    await page.click('.mv-actions button:has-text("Undo last move")');
    expect(await locOf(page, "1401")).toBe("Range");
    expect(await locOf(page, "1402")).toBe("Range");
  });
});
