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
    await page.click('[data-nr-chip="incamp"]');
    await expect(page.locator('[data-nr-chip="incamp"]')).toHaveClass(/\bactive\b/);
    expect(await rowCount(page)).toBe(Number(tile));
    await expect(page.locator("#nr-summary")).toContainText(`${tile} shown`);
    // Out of camp is the complement, and picking it drops In camp.
    await page.click('[data-nr-chip="out"]');
    await expect(page.locator('[data-nr-chip="incamp"]')).not.toHaveClass(/\bactive\b/);
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

  test("a heading opens the sheet-style menu: sort, search, untick a value", async ({ page }) => {
    await seedAndGoto(page);
    await gotoRoster(page);
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

    // Untick Commander in the Role menu: ticks apply at once, menu stays open.
    const all = await page.evaluate(() => STATE.roster.length);
    const cmds = await page.evaluate(() => STATE.roster.filter(r => r.role === "Commander").length);
    await page.click('#content th[data-nr-th="role"]');
    await page.uncheck('#nr-colmenu input[data-nr-val="Commander"]');
    await expect(page.locator("#content tbody tr")).toHaveCount(all - cmds);
    await expect(page.locator("#nr-colmenu")).toBeVisible();
    await expect(page.locator('#content th[data-nr-th="role"] .nr-th-ico.on')).toHaveCount(1);
    await page.click("#nr-colmenu .nr-colmenu-done");
    await page.click("text=Clear filters");
    await expect(page.locator("#content tbody tr")).toHaveCount(all);
  });

  test("filter by value: only the Gunners, then add 2 MAT, then (Select all)", async ({ page }) => {
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
    // The sheet way: untick (Select all), then tick the one you want.
    await page.uncheck("#nr-colmenu-all");
    await expect(page.locator("#content tbody tr")).toHaveCount(0);
    await page.check('#nr-colmenu input[data-nr-val="Gunner"]');
    await expect(page.locator("#content tbody tr")).toHaveCount(2);
    await expect(page.locator("#content tbody")).toContainText("TEST MIXED");
    await page.check('#nr-colmenu input[data-nr-val="2 MAT"]');
    await expect(page.locator("#content tbody tr")).toHaveCount(3);

    // The value search narrows the list.
    await page.fill("#nr-colmenu-q", "lmg");
    await expect(page.locator("#nr-colmenu label[data-v]:visible")).toHaveCount(1);
    await page.fill("#nr-colmenu-q", "");
    await page.check("#nr-colmenu-all");
    await expect(page.locator("#content tbody tr")).toHaveCount(all);
    await expect(page.locator('#content th[data-nr-th="role"] .nr-th-ico.on')).toHaveCount(0);

    // Tapping outside closes it; Hide column removes the column.
    await page.click("#content h2");
    await expect(page.locator("#nr-colmenu")).toHaveCount(0);
    await page.click('#content th[data-nr-th="bmi"]');
    await page.click("#nr-colmenu >> text=Hide column");
    expect(await headers(page)).not.toContain("BMI");
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
});
