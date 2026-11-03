// Regression: the Columns picker's hint line slid under the modal's sticky
// header, because a fixed 52vh column list plus the rest outgrew the modal's
// 85vh cap and the whole modal scrolled. Now the list takes what is left, so
// the hint, the preset box and Apply are on screen at any height.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const SIZES = [
  { name: "laptop", width: 1250, height: 1070 },
  { name: "short laptop", width: 1280, height: 640 },
  { name: "phone", width: 390, height: 760 },
];

for (const size of SIZES) {
  test(`Columns picker fits without the modal scrolling (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await seedAndGoto(page);
    await page.evaluate(() => openNRColumns());
    await expect(page.locator("#modal-title")).toHaveText("Columns");
    await page.waitForTimeout(500);   // let the open animation settle

    // The modal itself does not scroll; only the column list does.
    const m = await page.$eval(".modal", (el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(m.sh).toBeLessThanOrEqual(m.ch + 1);
    const list = await page.$eval("#nr-cols", (el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(list.sh).toBeGreaterThan(list.ch);

    // The hint sits below the header, and Apply is inside the modal.
    const header = await page.locator(".modal-header").boundingBox();
    const hint = await page.locator("#modal-body", { hasText: "Tick the columns" }).locator("div").first().boundingBox();
    expect(hint.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    const modal = await page.locator(".modal").boundingBox();
    const apply = await page.locator("#modal-body button", { hasText: "Apply" }).boundingBox();
    expect(apply.y + apply.height).toBeLessThanOrEqual(modal.y + modal.height);

    if (size.name === "laptop") {
      await page.screenshot({ path: test.info().outputPath("columns.png") });
    }
  });
}

test("closing the Columns picker leaves the next modal unchanged", async ({ page }) => {
  await seedAndGoto(page);
  await page.click('.nav-btn[data-nav="roster"]');
  await page.click("text=Columns");
  await page.evaluate(() => closeModal());
  await page.evaluate(() => openAppointmentForm(""));
  expect(await page.$eval(".modal", (el) => el.classList.contains("fit"))).toBe(false);
});

// The root cause, in every modal: the sticky header used to sit 22px low and
// cover the top of the body. It must be flush with the modal's top edge, at
// rest and when the modal is scrolled, and never overlap the first field.
for (const size of SIZES.filter((s) => s.name !== "laptop")) {
  test(`modal header is flush and covers nothing (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await seedAndGoto(page);
    await page.evaluate(() => openMedicalForm());
    await page.waitForTimeout(500);
    const modal = await page.locator(".modal").boundingBox();
    const header = await page.locator(".modal-header").boundingBox();
    expect(Math.abs(header.y - modal.y)).toBeLessThanOrEqual(2);
    const first = await page.locator("#modal-body label").first().boundingBox();
    expect(first.y).toBeGreaterThanOrEqual(header.y + header.height - 1);

    await page.$eval(".modal", (el) => { el.scrollTop = el.scrollHeight; });
    const after = await page.locator(".modal-header").boundingBox();
    expect(Math.abs(after.y - modal.y)).toBeLessThanOrEqual(2);
  });
}
