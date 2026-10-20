// Feature spec for roles and qualifications: a recruit's section role
// (`billet`), extra roles and qualifications with optional expiry. Seeds
// synthetic people at runtime and drives the real popup, forms, Roster table
// and Log Conduct panel.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Section roles", () => {
  test("a role shows on his card and in the Roster table, and can be changed", async ({ page }) => {
    await seedAndGoto(page);

    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([
        { id: "9901", name: "TEST GUNNER", role: "Recruit", billet: "1 LMG" },
        { id: "9902", name: "TEST NOROLE", role: "Recruit" },
      ]));
      openPerson("9901");
    });

    const body = page.locator("#modal-body");
    await expect(body).toContainText("1 LMG");

    await page.evaluate(() => openRolesForm("9901"));
    await page.locator("#f-billet").fill("LAW 2IC");
    await page.locator("#modal-body button[type=submit]").click();
    await expect(page.locator("#modal-overlay")).toHaveClass(/hidden/);

    const saved = await page.evaluate(() => STATE.roster.find(r => r.id === "9901").billet);
    expect(saved).toBe("LAW 2IC");

    await page.evaluate(() => { STATE.nav = "roster"; render(); });
    await expect(page.locator("tr", { hasText: "TEST GUNNER" })).toContainText("LAW 2IC");
    await expect(page.locator("tr", { hasText: "TEST NOROLE" })).not.toContainText("Recruit");

    await page.evaluate(() => openPerson("9902"));
    await expect(body).toContainText("No role");
  });

  test("normalizeRoster always emits billet, blank when unassigned", async ({ page }) => {
    await seedAndGoto(page);
    const rows = await page.evaluate(() => normalizeRoster([{ id: "9903", name: "X" }]));
    expect(rows[0].billet).toBe("");
    expect(rows[0].secondaryRoles).toBe("");
    expect(rows[0].quals).toBe("");
  });

  test("roles and quals edited on the card show as chips and save to the row", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([{ id: "9904", name: "TEST MEDIC", role: "Recruit", quals: "Water Safety@2020-01-01" }]));
      openRolesForm("9904");
    });
    await page.locator("#f-roles2").fill("Medic, Runner");
    await page.locator("text=+ Add qualification").click();
    await page.locator("[data-qual-name]").last().fill("CPR");
    await page.locator("[data-qual-exp]").last().fill("2099-12-31");
    await page.locator("#modal-body button[type=submit]").click();

    const row = await page.evaluate(() => STATE.roster.find(r => r.id === "9904"));
    expect(row.secondaryRoles).toBe("Medic, Runner");
    expect(row.quals).toBe("Water Safety@2020-01-01, CPR@2099-12-31");

    await page.evaluate(() => openPerson("9904"));
    const body = page.locator("#modal-body");
    await expect(body.locator(".badge", { hasText: "Medic" })).toBeVisible();
    await expect(body.locator(".badge-green", { hasText: "CPR" })).toBeVisible();
    await expect(body.locator(".qual-expired", { hasText: "Water Safety" })).toBeVisible();
  });

  test("a delimiter in a qual name is refused, nothing is saved", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([{ id: "9905", name: "TEST COMMA", role: "Recruit" }]));
      openRolesForm("9905");
    });
    await page.locator("[data-qual-name]").first().fill("CPR@AED");
    page.once("dialog", d => d.accept());
    await page.locator("#modal-body button[type=submit]").click();
    expect(await page.evaluate(() => STATE.roster.find(r => r.id === "9905").quals)).toBe("");
  });

  test("bulk award, roster filter and the Log Conduct panel", async ({ page }) => {
    await seedAndGoto(page);
    const today = await page.evaluate(() => todayISO());
    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([
        { id: "0091", name: "TEST SAFETY", role: "Commander", rank: "3SG" },
        { id: "9911", name: "TEST ALPHA", role: "Recruit" },
        { id: "9912", name: "TEST BRAVO", role: "Recruit" },
      ]));
      openQualAwardForm("Range Safety Officer");
    });
    for (const d4 of ["0091", "9911", "9912"]) await page.locator(`#group-member-list input[data-d4="${d4}"]`).check();
    await page.locator("#f-award-exp").fill("2099-01-01");
    await page.locator("text=Save holders").click();
    const holders = await page.evaluate(() => qualHolders("Range Safety Officer").map(h => h.r.id).sort());
    expect(holders).toEqual(["0091", "9911", "9912"]);

    // Roster filter narrows to holders and adds the expiry column.
    await page.evaluate(() => { STATE.nav = "roster"; STATE.filterRole = ""; render(); setRosterQual("Range Safety Officer"); });
    await expect(page.locator("#content tbody tr")).toHaveCount(3);
    await expect(page.locator("#content thead")).toContainText("Expiry");

    // One holder goes on MC today: the panel still lists him, as unavailable.
    await page.evaluate((d) => {
      STATE.medical.push({ id: "m-test-1", d4: "9912", status: "MC", startDate: isoToDisplayDate(d), endDate: isoToDisplayDate(d), reason: "fever" });
      openLogConductWizard();
    }, today);
    const panel = page.locator("#wiz-qual-panel");
    await panel.locator("summary").click();
    await panel.locator("button", { hasText: "Range Safety Officer" }).click();
    await expect(panel).toContainText("2 available of 3");
    await expect(page.locator("#wiz-qual-panel div", { hasText: "TEST BRAVO" }).last()).toContainText("MC");
  });
});
