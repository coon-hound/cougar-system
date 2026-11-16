// Master NR: the Roster view as a configurable nominal roll. The Default preset
// must be the Roster exactly as it was; everything else is opt-in per device.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// Heading text without the menu marker (▾ / ▲ / ▼ / ⧩).
const headers = (page) => page.$$eval("#content table thead th", ths => ths.map(t => {
  const c = t.cloneNode(true); c.querySelector(".nr-th-ico")?.remove(); return c.textContent.trim();
}));
const rowCount = (page) => page.locator("#content table tbody tr").count();

async function gotoRoster(page) {
  await page.click('.nav-btn[data-nav="roster"]');
  await expect(page.locator("#content h2")).toContainText("Master NR");
}

test.describe("Master NR", () => {
  test("Default preset is the old Roster: same columns, same Camp levers", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await seedAndGoto(page);
    await gotoRoster(page);

    expect(await headers(page)).toEqual(["4D", "Name", "Role", "Status", "Camp", "BMI", "RSIs"]);
    await expect(page.locator("#nr-preset")).toHaveValue("default");
    const n = await page.evaluate(() => STATE.roster.length);
    expect(await rowCount(page)).toBe(n);
    // Every row keeps its Book out lever in the Camp cell, and the row still
    // opens the person card.
    await expect(page.locator("#content tbody tr td:nth-child(5) button").first()).toContainText("Book out");
    await expect(page.locator('#content tbody tr[onclick^="openPerson("]')).toHaveCount(n);
    // + Commander / Groups now live behind the overflow, not in the header row.
    await expect(page.locator("#nr-menu")).toBeHidden();
    await page.click("#nr-more-btn");
    await expect(page.locator("#nr-menu")).toBeVisible();
    await expect(page.locator("#nr-menu")).toContainText("+ Commander");
    await expect(page.locator("#nr-menu")).toContainText("Groups");
    await page.click("#content h2");
    await expect(page.locator("#nr-menu")).toBeHidden();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("the In camp chip count equals the dashboard In Camp tile", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      const r = STATE.roster.find(x => x.role !== "Commander");
      r.outOfCamp = true; r.outSince = todayISO(); r.outReason = "Test";
      saveLocal(); STATE.nav = "dashboard"; render();
    });
    const tile = await page.locator(".stat", { has: page.locator("label", { hasText: /^In Camp$/ }) }).locator(".val").innerText();
    await gotoRoster(page);
    await page.click('[data-nr-chip="incamp"] .nr-qchip-main');
    await expect(page.locator('[data-nr-chip="incamp"]')).toHaveClass(/\binc\b/);
    expect(await rowCount(page)).toBe(Number(tile));
    await expect(page.locator("#nr-summary")).toContainText(`${tile} shown`);
    // Out of camp is the complement, and picking it drops In camp.
    await page.click('[data-nr-chip="out"] .nr-qchip-main');
    await expect(page.locator('[data-nr-chip="incamp"]')).not.toHaveClass(/\binc\b/);
    expect(await rowCount(page)).toBe(1);
  });

  test("column choices persist across a reload", async ({ page }) => {
    await seedAndGoto(page);
    await gotoRoster(page);
    await page.click("text=Columns");
    await expect(page.locator("#modal-title")).toHaveText("Columns");
    await page.check('#nr-cols input[data-nr-col="plt"]');
    await page.uncheck('#nr-cols input[data-nr-col="bmi"]');
    await page.click("text=Apply");
    let h = await headers(page);
    expect(h).toContain("Platoon");
    expect(h).not.toContain("BMI");
    await expect(page.locator("#nr-preset")).toHaveValue("");

    await page.reload();
    await page.waitForFunction(() => typeof STATE !== "undefined" && Array.isArray(STATE.roster));
    await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
    await gotoRoster(page);
    h = await headers(page);
    expect(h).toEqual(["4D", "Name", "Role", "Status", "Camp", "RSIs", "Platoon"]);

    // Picking a preset replaces the columns; Default restores the original.
    await page.selectOption("#nr-preset", "ippt");
    expect(await headers(page)).toContain("IPPT score");
    await page.selectOption("#nr-preset", "default");
    expect(await headers(page)).toEqual(["4D", "Name", "Role", "Status", "Camp", "BMI", "RSIs"]);
  });

  test("Export view writes exactly the visible columns and rows", async ({ page }) => {
    await seedAndGoto(page);
    await gotoRoster(page);
    await page.selectOption("#nr-preset", "daily");
    // Capture what reaches exportCSV rather than depending on the download.
    await page.evaluate(() => { window.__csv = null; window.exportCSV = (data, name) => { window.__csv = { data, name }; }; });
    await page.click("#nr-more-btn");
    await page.click("text=Export view (CSV)");
    const csv = await page.evaluate(() => window.__csv);
    expect(csv.name).toMatch(/^master-nr-daily-strength-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(Object.keys(csv.data[0])).toEqual(await headers(page));
    expect(csv.data.length).toBe(await rowCount(page));
    // No HTML leaks into the export (the Camp column exports its label).
    expect(JSON.stringify(csv.data)).not.toMatch(/<\w/);
  });

  test("a heading opens the menu: sort, search, exclude a value", async ({ page }) => {
    await seedAndGoto(page);
    await gotoRoster(page);
    await expect(page.locator("#nr-summary")).toContainText("tap a chip to show only, its − to hide");
    await expect(page.locator("#nr-summary")).toContainText("tap a column heading to sort or filter");

    // Sort A to Z from the Name heading's menu.
    await page.click('#content th[data-nr-th="name"]');
    await expect(page.locator("#nr-colmenu")).toBeVisible();
    await page.click('#nr-colmenu [data-nr-sort="asc"]');
    await expect(page.locator("#nr-colmenu")).toHaveCount(0);
    expect((await headers(page))[1]).toBe("Name");
    await expect(page.locator('#content th[data-nr-th="name"] .nr-th-ico.on')).toHaveText("▲");
    const names = await page.$$eval("#content tbody tr td:nth-child(2)", tds => tds.map(t => t.textContent.trim()));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));

    // The page search still narrows and keeps focus.
    await page.fill("#nr-search", "bravo");
    await expect(page.locator("#content tbody tr")).toHaveCount(3);
    await expect(page.locator("#nr-search")).toBeFocused();
    await page.fill("#nr-search", "");

    // Commander in the Role menu: the value shows only the commanders, its −
    // hides them. Taps apply at once and the menu stays open.
    const all = await page.evaluate(() => STATE.roster.length);
    const cmds = await page.evaluate(() => STATE.roster.filter(r => r.role === "Commander").length);
    await page.click('#content th[data-nr-th="role"]');
    const cmdr = page.locator('#nr-colmenu [data-nr-val="Commander"]');
    await cmdr.locator(".nr-colmenu-pick").click();
    await expect(cmdr).toHaveAttribute("data-state", "in");
    await expect(page.locator("#content tbody tr")).toHaveCount(cmds);
    // Its − hides them straight away, no second pass through "show only".
    await cmdr.locator(".nr-colmenu-hide").click();
    await expect(cmdr).toHaveAttribute("data-state", "out");
    await expect(page.locator("#content tbody tr")).toHaveCount(all - cmds);
    await expect(page.locator("#nr-colmenu")).toBeVisible();
    await expect(page.locator('#content th[data-nr-th="role"] .nr-th-ico.on')).toHaveCount(1);
    // The filter is spelled out above the table.
    await expect(page.locator('#nr-pills [data-nr-pill="role"]')).toContainText("Role: not Commander");
    await page.click("#nr-colmenu .nr-colmenu-done");
    await page.click("text=Clear filters");
    await expect(page.locator("#content tbody tr")).toHaveCount(all);
    await expect(page.locator("#nr-pills")).toHaveCount(0);
  });

  test("filter by value: show only the Gunners, add 2 MAT, then clear", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([
        { id: "9901", name: "TEST GUNNER", role: "Recruit", billet: "Gunner" },
        { id: "9902", name: "TEST MIXED", role: "Recruit", billet: "2 LMG / Gunner" },
        { id: "9903", name: "TEST MAT", role: "Recruit", billet: "2 MAT" },
      ]));
    });
    await gotoRoster(page);
    const all = await page.evaluate(() => STATE.roster.length);
    await page.click('#content th[data-nr-th="role"]');
    await expect(page.locator("#nr-colmenu")).toContainText("Tap a value to show only it, its − to hide it.");
    // A short list has no search box.
    await expect(page.locator("#nr-colmenu-q")).toHaveCount(0);
    await expect(page.locator("#nr-colmenu-clear")).toBeHidden();
    await page.click('#nr-colmenu [data-nr-val="Gunner"] .nr-colmenu-pick');
    await expect(page.locator("#content tbody tr")).toHaveCount(2);
    await expect(page.locator("#content tbody")).toContainText("TEST MIXED");
    await page.click('#nr-colmenu [data-nr-val="2 MAT"] .nr-colmenu-pick');
    await expect(page.locator("#content tbody tr")).toHaveCount(3);
    // Two + values on a multi-valued column offer any / all.
    await expect(page.locator("#nr-colmenu-match")).toBeVisible();
    await page.click('#nr-colmenu [data-nr-match="all"]');
    await expect(page.locator("#content tbody tr")).toHaveCount(0);
    await expect(page.locator('#nr-pills [data-nr-pill="role"]')).toContainText("Role: Gunner and 2 MAT");
    await page.click('#nr-colmenu [data-nr-match="any"]');
    await expect(page.locator("#content tbody tr")).toHaveCount(3);

    await page.click("#nr-colmenu-clear");
    await expect(page.locator("#content tbody tr")).toHaveCount(all);
    await expect(page.locator('#content th[data-nr-th="role"] .nr-th-ico.on')).toHaveCount(0);
    await expect(page.locator('#nr-colmenu [data-nr-val="Gunner"]')).toHaveAttribute("data-state", "");

    // Tapping outside closes it; Hide column removes the column.
    await page.click("#content h2");
    await expect(page.locator("#nr-colmenu")).toHaveCount(0);
    await page.click('#content th[data-nr-th="bmi"]');
    await page.click("#nr-colmenu >> text=Hide column");
    expect(await headers(page)).not.toContain("BMI");
  });

  test("excluding a value hides a man who has it alongside others", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([
        { id: "9901", name: "TEST GUNNER", role: "Recruit", billet: "Gunner" },
        { id: "9902", name: "TEST MIXED", role: "Recruit", billet: "2 LMG / Gunner" },
      ]));
    });
    await gotoRoster(page);
    await page.click('#content th[data-nr-th="role"]');
    const lmg = page.locator('#nr-colmenu [data-nr-val="2 LMG"]');
    await lmg.locator(".nr-colmenu-hide").click();
    await expect(page.locator("#content tbody")).toContainText("TEST GUNNER");
    await expect(page.locator("#content tbody")).not.toContainText("TEST MIXED");
  });

  test("+ Filter reaches a column that is not shown; its pill edits and drops it", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([
        { id: "9901", name: "TEST BOTH", role: "Recruit", quals: "LMG LF, M203 LF", age: "21" },
        { id: "9902", name: "TEST LMG", role: "Recruit", quals: "LMG LF", age: "19" },
        { id: "9903", name: "TEST NONE", role: "Recruit", quals: "", age: "18" },
      ]));
    });
    await gotoRoster(page);
    const all = await page.evaluate(() => STATE.roster.length);
    expect(await headers(page)).not.toContain("Qualifications");

    await page.selectOption("#nr-addfilter", "quals");
    await expect(page.locator("#nr-colmenu")).toBeVisible();
    // The picker holds its pick while the menu is up, and resets when it closes.
    await expect(page.locator("#nr-addfilter")).toHaveValue("quals");
    // A hidden column has no sort, and offers to show itself.
    await expect(page.locator("#nr-colmenu [data-nr-sort]")).toHaveCount(0);
    await expect(page.locator("#nr-colmenu")).toContainText("Show column");
    const lmg = page.locator('#nr-colmenu [data-nr-val="LMG LF"]');
    await lmg.locator(".nr-colmenu-hide").click();
    await expect(page.locator("#content tbody tr")).toHaveCount(all - 2);
    await expect(page.locator('#nr-pills [data-nr-pill="quals"]')).toContainText("Qualifications: not LMG LF");
    await page.click("#nr-colmenu .nr-colmenu-done");
    await expect(page.locator("#nr-addfilter")).toHaveValue("");

    // The pill reopens the same menu, in the same state.
    await page.click('#nr-pills [data-nr-pill="quals"] .nr-pill-main');
    await expect(page.locator('#nr-colmenu [data-nr-val="LMG LF"]')).toHaveAttribute("data-state", "out");
    await page.keyboard.press("Escape");
    await expect(page.locator("#nr-colmenu")).toHaveCount(0);

    // A number column takes a range, typed in place. With LMG LF excluded,
    // nobody left is 19 or older (a blank age is outside any range).
    await page.selectOption("#nr-addfilter", "age");
    await page.fill('#nr-colmenu [data-nr-range="min"]', "19");
    await expect(page.locator('#nr-pills [data-nr-pill="age"]')).toContainText("Age: 19 or more");
    await expect(page.locator("#content .empty-state")).toContainText("No personnel match these filters.");
    await expect(page.locator('#nr-colmenu [data-nr-range="min"]')).toBeFocused();
    await page.click("#nr-colmenu .nr-colmenu-done");

    // The ✕ drops one filter and leaves the other.
    await page.click('#nr-pills [data-nr-pill="quals"] .nr-pill-x');
    await expect(page.locator('#nr-pills [data-nr-pill="quals"]')).toHaveCount(0);
    await expect(page.locator("#content tbody tr")).toHaveCount(2);
    // Both survive a reload as the device's view.
    await page.reload();
    await page.waitForFunction(() => typeof STATE !== "undefined" && Array.isArray(STATE.roster));
    await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); STATE.nav = "roster"; render(); });
    await expect(page.locator('#nr-pills [data-nr-pill="age"]')).toContainText("Age: 19 or more");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a chip: the label shows only, the − hides, each in one tap", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      const r = STATE.roster.find(x => x.role !== "Commander");
      r.outOfCamp = true; r.outSince = todayISO(); r.outReason = "Test";
      saveLocal();
    });
    await gotoRoster(page);
    const all = await page.evaluate(() => STATE.roster.length);
    const chip = page.locator('[data-nr-chip="out"]');
    await chip.locator(".nr-qchip-main").click();
    await expect(chip).toHaveClass(/\binc\b/);
    await expect(chip.locator(".nr-qchip-main")).toHaveText("+ Out of camp");
    expect(await rowCount(page)).toBe(1);
    await chip.locator(".nr-qchip-hide").click();
    await expect(chip).toHaveClass(/\bexc\b/);
    await expect(chip.locator(".nr-qchip-main")).toHaveText("− Out of camp");
    await expect(chip.locator(".nr-qchip-hide")).toHaveText("✕");
    expect(await rowCount(page)).toBe(all - 1);
    await chip.locator(".nr-qchip-hide").click();
    await expect(chip).toHaveAttribute("data-state", "");
    expect(await rowCount(page)).toBe(all);
  });

  test("platoon chips and the Platoon pill are one filter", async ({ page }) => {
    await seedAndGoto(page);
    await gotoRoster(page);
    const plts = await page.evaluate(() => [...new Set(STATE.roster.map(getPlt))].length);
    await expect(page.locator(".nr-chiprow [data-nr-plt]")).toHaveCount(plts);
    const inPl1 = await page.evaluate(() => STATE.roster.filter(r => getPlt(r) === "1").length);
    await page.click('.nr-chiprow [data-nr-plt="1"] .nr-qchip-main');
    expect(await rowCount(page)).toBe(inPl1);
    await expect(page.locator('#nr-pills [data-nr-pill="plt"]')).toContainText("Platoon: PL 1");
    await page.click('.nr-chiprow [data-nr-plt="1"] .nr-qchip-hide');
    await expect(page.locator('#nr-pills [data-nr-pill="plt"]')).toContainText("Platoon: not PL 1");
    expect(await rowCount(page)).toBe((await page.evaluate(() => STATE.roster.length)) - inPl1);
  });

  test("☆ Save view keeps the filters and brings them back", async ({ page }) => {
    await seedAndGoto(page);
    await gotoRoster(page);
    const all = await page.evaluate(() => STATE.roster.length);
    await page.click('#content th[data-nr-th="role"]');
    await page.click('#nr-colmenu [data-nr-val="Commander"] .nr-colmenu-hide');
    await page.click("#nr-colmenu .nr-colmenu-done");
    const kept = await rowCount(page);
    expect(kept).toBeLessThan(all);
    await page.click("text=☆ Save view");
    await expect(page.locator("#modal-title")).toHaveText("☆ Save view");
    await expect(page.locator("#modal-body")).toContainText("Role: not Commander");
    await page.fill("#nr-view-name", "No commanders");
    await page.click("#modal-body >> text=Save view");
    await expect(page.locator("#nr-preset option:checked")).toHaveText("No commanders");
    // Clear, switch layout, then pick the view: the filter comes back.
    await page.click("text=Clear filters");
    expect(await rowCount(page)).toBe(all);
    await page.selectOption("#nr-preset", "ippt");
    const id = await page.evaluate(() => NR.load().custom[0].id);
    await page.selectOption("#nr-preset", id);
    expect(await rowCount(page)).toBe(kept);
    await expect(page.locator('#nr-pills [data-nr-pill="role"]')).toBeVisible();
  });

  test("phone: the view scrolls sideways with Name pinned", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAndGoto(page);
    await page.evaluate(() => { STATE.nav = "roster"; render(); });
    await page.selectOption("#nr-preset", "contacts");
    const pos = await page.$eval("#content tbody tr td.nr-sticky", td => getComputedStyle(td).position);
    expect(pos).toBe("sticky");
    const overflow = await page.$eval("#content .table-wrap", w => w.scrollWidth > w.clientWidth);
    expect(overflow).toBe(true);
    // The page itself never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/master-nr-phone.png" });
  });

  test("phone: pills wrap and the filter menu stays on screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAndGoto(page);
    await page.evaluate(() => {
      localStorage.setItem(NR.LS_KEY, JSON.stringify({ preset: "default", xchips: ["leave"], filters: {
        role: { out: ["Commander"] }, plt: { out: ["3", "4"] }, status: { out: ["MC", "LD"] },
      } }));
      STATE.nav = "roster"; render();
    });
    await expect(page.locator("#nr-pills .nr-pill")).toHaveCount(3);
    await expect(page.locator('#nr-pills [data-nr-pill="plt"]')).toContainText("Platoon: not PL 3 or PL 4");
    expect(await rowCount(page)).toBeGreaterThan(0);
    await expect(page.locator('[data-nr-chip="leave"] .nr-qchip-main')).toHaveText("− On leave");
    // The chips are one row that scrolls sideways, not three stacked rows.
    const tops = await page.$$eval(".nr-chiprow .nr-qchip", cs => [...new Set(cs.map(c => Math.round(c.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.click('#content th[data-nr-th="status"]');
    // Measure after the pop-in: it scales the menu while it runs.
    await page.waitForFunction(() => document.getElementById("nr-colmenu").getAnimations().every(a => a.playState !== "running"));
    const box = await page.locator("#nr-colmenu").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    // Every value row is a full-height tap target, none squeezed.
    const heights = await page.$$eval("#nr-colmenu-list [data-nr-val]", bs => bs.map(b => b.offsetHeight));
    expect(heights.length).toBeGreaterThan(0);
    heights.forEach(h => expect(h).toBeGreaterThanOrEqual(36));
    await page.screenshot({ path: "test-results/master-nr-filters-phone.png" });
  });
});
