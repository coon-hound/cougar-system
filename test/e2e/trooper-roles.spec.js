// Feature spec for a recruit's section role (`billet`). Seeds synthetic people
// at runtime and drives the real popup, form and Roster table.
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

    await page.evaluate(() => openBilletForm("9901"));
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
  });
});
