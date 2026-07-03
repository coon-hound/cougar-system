// Feature spec for the Roster personal/NOK columns + per-recruit training program
// in the recruit popup. Seeds two synthetic people into STATE at runtime and
// drives openPerson() in the real browser, asserting the new cards/badge render
// for a detailed recruit and stay hidden for a commander.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Roster fields + program in the recruit popup", () => {
  test("detailed recruit shows program badge + Personal + Next of Kin", async ({ page }) => {
    await seedAndGoto(page);

    await page.evaluate(() => {
      STATE.roster.push({
        id: "9901", name: "TEST BMT REC", role: "Recruit", age: "20", program: "BMT",
        dob: "31/07/2005", bloodType: "O+", fieldOfStudy: "Cybersecurity", gpa: "GPA 3.08",
        smoker: "No", otherMedical: "Asthma", nokName: "Jane Tan", nokRelation: "Mother",
        nokPhone: "91234567", nokOccupation: "Teacher", address: "Blk 1 Test St #01-01"
      });
      openPerson("9901");
    });

    const body = page.locator("#modal-body");
    await expect(body).toBeVisible();
    // Program badge in the header + Personal card fields.
    await expect(body).toContainText("BMT");
    await expect(body).toContainText("Personal");
    await expect(body).toContainText("31/07/2005");
    await expect(body).toContainText("O+");
    await expect(body).toContainText("GPA 3.08");
    // Other-medical banner.
    await expect(body).toContainText("Other medical:");
    await expect(body).toContainText("Asthma");
    // Next of Kin card.
    await expect(body).toContainText("Next of Kin");
    await expect(body).toContainText("Jane Tan");
    await expect(body).toContainText("Teacher");

    await page.screenshot({ path: "test-results/roster-fields-popup.png", fullPage: true });
  });

  test("commander popup hides the personal/NOK cards and program badge", async ({ page }) => {
    await seedAndGoto(page);

    await page.evaluate(() => {
      STATE.roster.push({ id: "0031", name: "TEST COMD", role: "Commander", rank: "3SG" });
      openPerson("0031");
    });

    const body = page.locator("#modal-body");
    await expect(body).toBeVisible();
    await expect(body).toContainText("Commander");
    await expect(body).not.toContainText("Next of Kin");
    await expect(body).not.toContainText("Field of study");
  });
});
