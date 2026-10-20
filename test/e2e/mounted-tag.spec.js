// Feature spec for the Mounted / Dismounted tag, derived from the section role
// (`billet`). Synthetic people only.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Mounted / dismounted", () => {
  test("mountOf reads the role, and a mixed role is both", async ({ page }) => {
    await seedAndGoto(page);
    const got = await page.evaluate(() => [
      "Hunter Driver", "Gunner", " gunner ", "1 LMG", "", "2 LMG / Gunner", "GPMG / Gunner", "(2GL) / PC Runner",
    ].map(billet => mountOf({ role: "Recruit", billet })));
    expect(got).toEqual(["mounted", "mounted", "mounted", "dismounted", "dismounted", "both", "both", "dismounted"]);
    expect(await page.evaluate(() => mountOf({ role: "Commander", billet: "Gunner" }))).toBe("");
  });

  test("the roster filter keeps a mixed role under both sides and drops commanders", async ({ page }) => {
    await seedAndGoto(page);
    const ids = await page.evaluate(() => {
      STATE.roster = normalizeRoster([
        { id: "0091", name: "TEST CMD", role: "Commander", rank: "3SG" },
        { id: "9901", name: "TEST DRIVER", role: "Recruit", billet: "Hunter Driver" },
        { id: "9902", name: "TEST LMG", role: "Recruit", billet: "1 LMG" },
        { id: "9903", name: "TEST MIXED", role: "Recruit", billet: "2 LMG / Gunner" },
      ]);
      STATE.nav = "roster";
      const shown = f => { STATE.rosterMount = f; render(); return [...document.querySelectorAll("#content tbody tr")].map(tr => tr.children[1].textContent.trim().replace(/^3SG /, "")); };
      return { mounted: shown("mounted"), dismounted: shown("dismounted"), all: shown("") };
    });
    expect(ids.mounted).toEqual(["TEST DRIVER", "TEST MIXED"]);
    expect(ids.dismounted).toEqual(["TEST LMG", "TEST MIXED"]);
    expect(ids.all).toHaveLength(4);
    await expect(page.locator("tr", { hasText: "TEST MIXED" })).toContainText("Mounted + Dismounted");
  });

  test("the card shows the tag next to the role", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.roster.push(...normalizeRoster([{ id: "9904", name: "TEST GUNNER", role: "Recruit", billet: "Gunner" }]));
      openPerson("9904");
    });
    await expect(page.locator("#modal-body .badge", { hasText: "Mounted" })).toBeVisible();
  });
});
