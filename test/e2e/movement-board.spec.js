// Feature spec for the Movement Board. Every in-camp recruit sits in exactly one
// location bucket (default "Main Body"); out-of-camp bodies group into a single
// read-only "Out of Camp" card via the SAME outOfCampMap the strength board
// reads — so the card counts always reconcile to recruit strength. Movement is a
// day-scoped Roster field (location/locationSince) that auto-returns everyone to
// Main Body tomorrow, exactly like a manual book-out.
//
// UX: the primary move flow is on-board tap-to-move (enter move mode → tap
// recruit chips → tap a destination). The modal list-picker is the manual backup.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// Read a location card's { count, text } by its title, from the Movement board.
function cardOf(page, title) {
  return page.evaluate((t) => {
    const card = [...document.querySelectorAll(".mv-card")].find(c => {
      const h = c.querySelector(".mv-name");
      return h && h.innerText.replace(/^🚪\s*/, "").trim() === t;
    });
    if (!card) return null;
    return {
      count: card.querySelector(".mv-count")?.innerText.trim(),
      text: card.innerText.replace(/\s+/g, " ").trim(),
    };
  }, title);
}

test.describe("Movement Board", () => {
  test("partitions recruits into buckets; tap-to-move; counts reconcile to strength", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);

    // Everyone starts in Main Body (6 recruits, commander excluded), no Out card.
    expect((await cardOf(page, "Main Body")).count).toBe("6");
    expect(await cardOf(page, "Out of Camp")).toBeNull();

    // On-board move: enter move mode, tap two recruit chips, tap the Range drop button.
    await page.click('button:has-text("Move Bodies")');
    await page.click('.mv-chip[data-d4="1401"]');
    await page.click('.mv-chip[data-d4="1402"]');
    expect(await page.locator('#mv-sel-count').innerText()).toBe("2");
    await page.click('.mv-dest:has-text("Range")');

    expect((await cardOf(page, "Range")).count).toBe("2");
    expect((await cardOf(page, "Main Body")).count).toBe("4");
    // Buckets sum to recruit strength — nobody unaccounted for.
    expect(await page.evaluate(() => movementBuckets(todayISO()).reduce((n, b) => n + b.count, 0))).toBe(6);
    // Per-platoon pips: 1401/1402 are platoon 1 -> Range reads "P1 2".
    expect((await cardOf(page, "Range")).text).toContain("P1");

    // Board stays in move mode after a drop (multiple moves) — exit to normal.
    await page.click('button:has-text("Done")');

    // Recall All (automation) returns everyone in camp to Main Body in one tap.
    page.once("dialog", d => d.accept());
    await page.click('button:has-text("Recall all")');
    expect((await cardOf(page, "Main Body")).count).toBe("6");
    expect((await cardOf(page, "Range")).count).toBe("0");

    // Put 1403 on an away MC -> leaves in-camp cards, joins Out of Camp, and is
    // NOT offered as a selectable chip in move mode.
    await page.evaluate(() => {
      const today = isoToDisplayDate(todayISO());
      STATE.medical.push({ id: nextId(), d4: "1403", date: today, reason: "Fever", status: "MC", startDate: today, endDate: today, inCamp: false });
      saveLocal(); render();
    });
    expect((await cardOf(page, "Out of Camp")).count).toBe("1");
    expect((await cardOf(page, "Main Body")).count).toBe("5");
    expect(await page.evaluate(() => movementBuckets(todayISO()).reduce((n, b) => n + b.count, 0))).toBe(6);
    // Out-of-camp recruit has no selectable chip.
    await page.click('button:has-text("Move Bodies")');
    expect(await page.locator('.mv-chip[data-d4="1403"]').count()).toBe(0);
    await page.click('button:has-text("Cancel")');

    // Day-scoped auto-reset: stamp yesterday's locationSince -> collapse to Main Body.
    await page.evaluate(() => {
      const y = new Date(); y.setDate(y.getDate() - 1);
      const yIso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
      STATE.roster.forEach(r => { if (r.location) r.locationSince = yIso; });
      saveLocal(); render();
    });
    expect((await cardOf(page, "Main Body")).count).toBe("5");   // all in-camp back home
  });

  test("per-card pick-all + manual list picker + locations management", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);

    // Move mode: "Pick all here" grabs a whole location, drop into a card.
    await page.click('button:has-text("Move Bodies")');
    await page.click('.mv-selall');                 // pick all of Main Body (6)
    expect(await page.locator('#mv-sel-count').innerText()).toBe("6");
    await page.click('.mv-dest:has-text("Cookhouse")');
    expect((await cardOf(page, "Cookhouse")).count).toBe("6");
    await page.click('button:has-text("Done")');

    // Manual backup: the modal list-picker still works.
    await page.click('button:has-text("Move Bodies")');
    await page.click('button:has-text("List picker")');
    await page.check('#move-recruit-list input[data-d4="2401"]');
    await page.selectOption('#f-move-loc', 'Range');
    await page.click('button:has-text("Move selected")');
    expect((await cardOf(page, "Range")).count).toBe("1");
    await page.click('button:has-text("Done")');   // leave move mode

    // Rename a location -> its recruits follow.
    await page.click('button:has-text("Locations")');
    await page.fill('#loc-list [data-loc-row] input[data-orig="Range"]', 'Firing Range');
    await page.click('button:has-text("Save locations")');
    expect(await cardOf(page, "Range")).toBeNull();
    expect((await cardOf(page, "Firing Range")).count).toBe("1");
    expect(await page.evaluate(() => STATE.roster.find(r => r.id === "2401").location)).toBe("Firing Range");
  });

  test("quick-pick selects a whole unit (platoon / program) in one tap and toggles", async ({ page }) => {
    await seedAndGoto(page);
    await page.click(`.nav-btn[data-nav="movement"]`);
    await page.click('button:has-text("Move Bodies")');

    // One tap picks all of platoon 1 (1401/1402/1403 in camp).
    await page.click('.mv-qp[data-kind="plt"][data-val="1"]');
    expect(await page.locator('#mv-sel-count').innerText()).toBe("3");
    // Tapping the same unit again clears it (toggle).
    await page.click('.mv-qp[data-kind="plt"][data-val="1"]');
    expect(await page.locator('#mv-sel-count').innerText()).toBe("0");

    // Program quick-pick (PTP = plt 1 in this fixture) then drop to Range.
    await page.click('.mv-qp[data-kind="prog"][data-val="PTP"]');
    expect(await page.locator('#mv-sel-count').innerText()).toBe("3");
    await page.click('.mv-dest:has-text("Range")');
    expect((await cardOf(page, "Range")).count).toBe("3");
    expect((await cardOf(page, "Main Body")).count).toBe("3");
  });

  test("dashboard hero shows a distribution bar that reconciles to strength", async ({ page }) => {
    await seedAndGoto(page);
    // Split a couple recruits so the hero shows more than one segment.
    await page.evaluate(() => { moveToLocation(["1401", "1402"], "Range"); gotoNav("dashboard"); });
    const hero = await page.evaluate(() => {
      const h = document.querySelector(".mv-hero");
      if (!h) return null;
      const segs = [...h.querySelectorAll(".mv-seg")].map(s => +s.innerText.trim());
      return { hasBtn: !!h.querySelector("button"), segSum: segs.reduce((a, b) => a + b, 0), segCount: segs.length };
    });
    expect(hero).not.toBeNull();
    expect(hero.hasBtn).toBe(true);
    expect(hero.segCount).toBeGreaterThanOrEqual(2);   // Main Body + Range
    expect(hero.segSum).toBe(6);                        // reconciles to recruit strength
  });
});
