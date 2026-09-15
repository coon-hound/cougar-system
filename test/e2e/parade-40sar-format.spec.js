// The 40 SAR battalion parade-state format end to end: the generated text's
// skeleton (header, command team, one block per sub-unit, six fixed sections),
// and the command-team picker that fills the CDO/CDS/COS/PDS lines. The team
// rotates daily, so it is saved against the parade DATE, not the roster.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const RULE_EQ = "=".repeat(32);
const RULE_DASH = "-".repeat(32);

test("generated state follows the battalion skeleton", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);

  await page.evaluate(() => openReportModal("FP"));
  const text = await page.locator("#rep-text").inputValue();
  const lines = text.split("\n");

  expect(lines[0]).toBe("40 SAR COUGAR COMPANY");
  expect(lines[1]).toBe("FIRST PARADE STATE");
  expect(lines[2]).toMatch(/^DATE: \d{6} TIME: \d{4}$/);
  // Command team, then the two rules around the company strength summary.
  expect(text).toMatch(/^CDO: /m);
  expect(text).toMatch(/^COS: /m);
  expect(text.split(RULE_EQ).length).toBe(3);

  // COY HQ is filed first, then the platoons; each block carries the same six
  // sections in the same order, and no section is ever left blank.
  const blocks = text.split("\n" + RULE_DASH + "\n");
  expect(blocks.length).toBeGreaterThan(1);
  expect(blocks[0]).toContain("COY HQ: ");
  blocks.forEach(b => {
    const headers = b.split("\n").map(l => /^([A-Z][A-Z /]*): \d+$/.exec(l)).filter(Boolean).map(m => m[1]);
    expect(headers.join(",")).toBe("ATT C,STATUS,REPORT SICK,MA,OFF/LEAVE,OTHERS");
  });

  // Every strength line is present/strength, and the blocks add up to COMPANY.
  const strength = l => (l.match(/: (\d+)\/(\d+)$/) || []).slice(1).map(Number);
  const company = strength(lines.find(l => l.startsWith("COMPANY: ")));
  const blockTotals = lines
    .filter(l => /^(COY HQ|PL \d+): \d+\/\d+$/.test(l))
    .map(strength)
    .reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  expect(blockTotals).toEqual(company);

  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/parade-40sar-format.png", fullPage: true });
});

test("the command team is picked per date and remembered for it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);

  await page.evaluate(() => openReportModal("FP"));
  // Unfilled appointments print the battalion's placeholder, so a half-filled
  // command team is visible rather than silently missing.
  expect(await page.locator("#rep-text").inputValue()).toContain("CDO: <RANK> <NAME>");
  await expect(page.locator("#duty-section")).toContainText("unfilled");

  const cdo = page.locator("#duty-section label", { hasText: "CDO" }).locator("select");
  const before = await page.locator("#duty-missing").innerText();
  await cdo.selectOption({ index: 1 });
  const picked = (await cdo.locator("option:checked").innerText()).trim();
  expect(await page.locator("#rep-text").inputValue()).toContain(`CDO: ${picked.toUpperCase()}`);
  // The unfilled counter tracks the pick without rebuilding the selects (which
  // would drop the focus the user is still inside).
  expect(parseInt(await page.locator("#duty-missing").innerText(), 10))
    .toBe(parseInt(before, 10) - 1);
  await expect(cdo.locator("option:checked")).toHaveText(picked);

  // Saved against the parade date, so reopening the same date restores it.
  const date = await page.locator("#rep-date").inputValue();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cougar-duty") || "{}"));
  expect(Object.keys(stored)).toEqual([date]);

  await page.evaluate(() => { closeModal(); openReportModal("FP"); });
  await expect(page.locator("#duty-section label", { hasText: "CDO" }).locator("option:checked")).toHaveText(picked);

  expect(errors).toEqual([]);
});
