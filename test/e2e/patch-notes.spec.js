// Feature spec: "What's New" notes come from notes/index.json (built by the
// deploy from notes/*.json), are shown once per device, and never cover a
// modal he has already opened.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const NOTES = [
  { id: "2026-11-10-b", date: "10 Nov 2026", title: "Second note", items: [{ t: "B item", d: "detail" }] },
  { id: "2026-11-03-a", date: "3 Nov 2026", title: "First note", items: ["A item"] },
];

test.describe("patch notes from notes/index.json", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/notes/index.json", (r) => r.fulfill({ json: NOTES }));
  });

  test("unseen notes show once, newest first; seen ones never again", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => { closeModal(); localStorage.removeItem("cougar-seen-notes"); });
    await page.evaluate(() => maybeShowPatchNotes());
    const body = page.locator("#modal-body");
    await expect(page.locator("#modal-title")).toHaveText("What's New");
    await expect(body).toContainText("Second note");
    await expect(body).toContainText("First note");
    const text = await body.textContent();
    expect(text.indexOf("Second note")).toBeLessThan(text.indexOf("First note"));
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cougar-seen-notes")))).toEqual(["2026-11-10-b", "2026-11-03-a"]);

    await page.evaluate(() => closeModal());
    await page.evaluate(() => maybeShowPatchNotes());
    await expect(page.locator("#modal-overlay")).toBeHidden();
  });

  test("an open form is not covered; the notes wait for next launch", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => { closeModal(); localStorage.removeItem("cougar-seen-notes"); openAppointmentForm(""); });
    await page.evaluate(() => maybeShowPatchNotes());
    await expect(page.locator("#modal-title")).toHaveText("Book Appointment");
    expect(await page.evaluate(() => localStorage.getItem("cougar-seen-notes"))).toBeNull();
  });
});
