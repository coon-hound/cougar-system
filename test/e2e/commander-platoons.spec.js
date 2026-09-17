// Tagging a commander to a platoon: the Add/Edit Commander form's Platoon
// picker, and the effect it has on the parade state (filed under the
// platoon's block, counted on that block's WOSPEC line, never on ENLISTEE)
// and on the platoon filter. An untagged commander must keep filing under
// COY HQ exactly as before.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// The seeded commander: 3SG COMD TAN, 0001, no platoon. The seeded recruits
// sit in platoons 1 and 2 (three each).
const CMD = "0001";

// The block a strength label belongs to, as "<LABEL>: <present>/<strength>".
const strengthOf = (text, label) => {
  const m = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ": (\\d+)\\/(\\d+)$", "m").exec(text);
  return m ? { present: +m[1], strength: +m[2] } : null;
};

// The chunk of the parade text belonging to one block, from its header line to
// the next block header (or the end). Rank lines are scoped to their block, so
// a global regex would read PL 1's WOSPEC count off COY HQ.
function blockChunk(text, label) {
  const lines = text.split("\n");
  const start = lines.findIndex(l => l === label + ": " + (strengthOf(text, label).present) + "/" + (strengthOf(text, label).strength));
  const isHeader = l => /^(COY HQ|PL \d+): \d+\/\d+$/.test(l);
  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

test("an untagged commander files under COY HQ", async ({ page }) => {
  await seedAndGoto(page);
  await page.evaluate(() => openReportModal("FP"));
  const text = await page.locator("#rep-text").inputValue();

  // One commander in the fixture, coy-level, so COY HQ holds exactly him and
  // he is a WOSPEC (3SG), not an enlistee.
  expect(strengthOf(text, "COY HQ")).toEqual({ present: 1, strength: 1 });
  expect(strengthOf(blockChunk(text, "COY HQ"), "WOSPEC")).toEqual({ present: 1, strength: 1 });
  expect(strengthOf(blockChunk(text, "COY HQ"), "ENLISTEE")).toEqual({ present: 0, strength: 0 });
  expect(strengthOf(blockChunk(text, "PL 1"), "WOSPEC")).toEqual({ present: 0, strength: 0 });
});

test("the commander form tags a platoon, and the parade state files him there", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await seedAndGoto(page);

  // Company strength before the change — tagging moves a man between blocks,
  // it must never add or remove one.
  await page.evaluate(() => openReportModal("FP"));
  const before = await page.locator("#rep-text").inputValue();
  const company = strengthOf(before, "COMPANY");
  await page.evaluate(() => closeModal());

  // Tag him to platoon 1 through the real form.
  await page.evaluate(id => openCommanderForm(id), CMD);
  await expect(page.locator("#f-plt")).toBeVisible();
  // The picker offers COY HQ plus exactly the platoons the recruits are in.
  expect(await page.locator("#f-plt option").allTextContents())
    .toEqual(["COY HQ (no platoon)", "Platoon 1", "Platoon 2"]);
  await page.locator("#f-plt").selectOption("1");
  await page.locator("#f-plt").evaluate(el => el.form.requestSubmit());
  await expect(page.locator("#modal-overlay")).toBeHidden();

  expect(await page.evaluate(id => STATE.roster.find(r => r.id === id).plt, CMD)).toBe("1");

  await page.evaluate(() => openReportModal("FP"));
  const after = await page.locator("#rep-text").inputValue();

  // He left COY HQ and joined PL 1 — on the WOSPEC line, so PL 1's ENLISTEE
  // count (its actual men) is untouched.
  expect(strengthOf(after, "COY HQ")).toEqual({ present: 0, strength: 0 });
  expect(strengthOf(blockChunk(after, "PL 1"), "WOSPEC")).toEqual({ present: 1, strength: 1 });
  expect(strengthOf(blockChunk(after, "PL 1"), "ENLISTEE"))
    .toEqual(strengthOf(blockChunk(before, "PL 1"), "ENLISTEE"));

  // One body moved between blocks: the company total cannot have changed, and
  // the blocks still sum to it.
  expect(strengthOf(after, "COMPANY")).toEqual(company);
  const blockTotals = after.split("\n")
    .filter(l => /^(COY HQ|PL \d+): \d+\/\d+$/.test(l))
    .map(l => l.match(/: (\d+)\/(\d+)$/).slice(1).map(Number))
    .reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  expect(blockTotals).toEqual([company.present, company.strength]);

  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/commander-platoons.png", fullPage: true });
});

test("a tagged commander appears under his platoon's filter", async ({ page }) => {
  await seedAndGoto(page);
  await page.evaluate(id => {
    const r = STATE.roster.find(x => x.id === id);
    r.plt = "2";
    saveLocal(); render();
  }, CMD);

  // Platoon 2 now holds its three men plus him; platoon 1 does not see him.
  const inPlt = await page.evaluate(() => {
    const pick = p => { STATE.filterPlt = p; return filteredRoster().map(r => r.id); };
    return { two: pick("2"), one: pick("1") };
  });
  expect(inPlt.two).toContain(CMD);
  expect(inPlt.one).not.toContain(CMD);
});
