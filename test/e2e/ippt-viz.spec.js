// IPPT tab: the current phase (IPPT at Keat Hong) leads; BMT history is one
// collapsed card at the bottom that opens into the same full analytics.
// Attempt numbers restart per series, so the two are never mixed in one chart.
//
// Fixture cohort (see fixtures/demo-seed.json "ippt"):
//   BMT: C1401 60→70→85 (+25, top improver)   C1402 65→72→78
//        C1403 80→74→70 (−10, only decliner)  C2401 75→68→76
//        C2402 55→ — →62 (missed BMT 2)       C2403 YTT (all-zero row, excluded)
//   KH 1: C1401 72, C1402 80, C1403 58, C2401 did not start (all-zero row);
//         C2402 and C2403 have no KH row at all.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

async function gotoIPPT(page) {
  await seedAndGoto(page);
  await page.click('[data-nav="ippt"]');
  await expect(page.locator("h2", { hasText: "IPPT Tracker" })).toBeVisible();
}

const KH = '[data-ippt-series="KH"]';
const BMT = '[data-ippt-series="BMT"]';

async function openBMT(page) {
  await page.locator(`${BMT} .dash-sec-toggle`).click();
  await expect(page.locator(`${BMT} .dash-sec-toggle`)).toHaveAttribute("aria-expanded", "true");
}

test("KH leads the tab; BMT is collapsed underneath and builds nothing until opened", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoIPPT(page);

  await expect(page.locator(`${KH} .ippt-series-title`)).toContainText("IPPT at Keat Hong");
  await expect(page.locator(`${KH} .ippt-series-title`)).toContainText("1 conduct · 4 results");
  // KH 1 stats: 3 took it (C2401's all-zero row is YTT), 2 passed, 1 failed.
  const stat = (label) => page.locator(`${KH} .stats-row .stat`, { has: page.locator("label", { hasText: new RegExp(`^${label}`) }) }).locator(".val");
  await expect(stat("Taken")).toHaveText("3/4");
  await expect(stat("Passed")).toHaveText("2");
  await expect(stat("Failed")).toHaveText("1");
  await expect(stat("YTT")).toHaveText("3");
  // The KH table lists KH rows only, labelled by series.
  await expect(page.locator(`${KH} table tbody tr`)).toHaveCount(4);
  await expect(page.locator(`${KH} table tbody tr`).first()).toContainText("KH 1");

  const bmt = page.locator(BMT);
  await expect(bmt.locator(".dash-sec-toggle")).toContainText("BMT IPPT results");
  await expect(bmt.locator(".dash-sec-toggle")).toContainText("3 conducts · 15 results");
  await expect(bmt.locator(".dash-sec-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#chart-ippt-bmt-progress")).toHaveCount(0);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  await page.screenshot({ path: "test-results/ippt-kh.png", fullPage: true });
});

test("KH YTT chase lists everyone without a KH result, including a did-not-start", async ({ page }) => {
  await gotoIPPT(page);
  const chase = page.locator(`${KH} .card`, { hasText: "YTT Chase List" });
  await expect(chase).toContainText("3 to chase");
  for (const name of ["BRAVO ONE", "BRAVO TWO", "BRAVO THREE"]) await expect(chase).toContainText(name);
  await expect(chase).not.toContainText("ALPHA ONE");
});

test("opening BMT shows its own conducts, charts and table - and stays open", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoIPPT(page);
  await openBMT(page);

  const bmt = page.locator(BMT);
  for (const n of [1, 2, 3]) await expect(bmt.locator(".role-btn", { hasText: `BMT ${n}` }).first()).toBeVisible();
  await expect(bmt.locator("table tbody tr")).toHaveCount(15);
  await expect(bmt.locator(".card", { hasText: "YTT Chase List" })).toHaveCount(0);
  // KH is untouched by BMT opening: still 4 rows, still its own stats.
  await expect(page.locator(`${KH} table tbody tr`)).toHaveCount(4);

  // Open state survives a re-render and a reload (it is the dashboard's store).
  await page.reload();
  await page.click('[data-nav="ippt"]');
  await expect(page.locator(`${BMT} .dash-sec-toggle`)).toHaveAttribute("aria-expanded", "true");

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  await page.screenshot({ path: "test-results/ippt-bmt-open.png", fullPage: true });
});

test("BMT score progression renders across all BMT conducts", async ({ page }) => {
  await gotoIPPT(page);
  await openBMT(page);
  const card = page.locator(`${BMT} [data-ippt-card="progression"]`);
  await expect(card).toBeVisible();
  await expect(card.locator("h3")).toContainText("Score Progression");
  await expect(card.locator("#chart-ippt-bmt-progress")).toBeAttached();
});

test("BMT compare defaults to first vs latest with the correct cohort and movers", async ({ page }) => {
  await gotoIPPT(page);
  await openBMT(page);

  const card = page.locator(`${BMT} [data-ippt-card="compare"]`);
  await expect(card).toBeVisible();
  await expect(card.locator("h3").first()).toContainText("BMT 1 → BMT 3");
  // 5 recruits have valid scores in both 1 and 3 (C2403's YTT row never counts);
  // 4 improved, 1 declined.
  await expect(card.locator("h3").first()).toContainText("5 took both");
  await expect(card.locator("h3").first()).toContainText("4 up");
  await expect(card.locator("h3").first()).toContainText("1 down");
  await expect(card.locator("#chart-ippt-bmt-scatter")).toBeAttached();

  const improved = card.locator("div", { has: page.locator("h3", { hasText: "Most improved" }) }).last();
  await expect(improved).toContainText("ALPHA ONE");
  await expect(improved).toContainText("+25");
  const drops = card.locator("div", { has: page.locator("h3", { hasText: "Biggest drops" }) }).last();
  await expect(drops).toContainText("ALPHA THREE");
  await expect(drops).toContainText("80 → 70");
});

test("any BMT conduct pair is selectable — BMT 2 → 3 recomputes the cohort", async ({ page }) => {
  await gotoIPPT(page);
  await openBMT(page);

  const card = page.locator(`${BMT} [data-ippt-card="compare"]`);
  for (const label of ["BMT 1 → 2", "BMT 1 → 3", "BMT 2 → 3"]) {
    await expect(card.locator(".role-btn", { hasText: label })).toBeVisible();
  }
  await card.locator(".role-btn", { hasText: "BMT 2 → 3" }).click();
  const after = page.locator(`${BMT} [data-ippt-card="compare"]`);
  await expect(after.locator("h3").first()).toContainText("BMT 2 → BMT 3");
  // C2402 missed BMT 2, so the paired cohort shrinks to 4 (3 up, 1 down).
  await expect(after.locator("h3").first()).toContainText("4 took both");
  await expect(after.locator("h3").first()).toContainText("3 up");
  await expect(after.locator("h3").first()).toContainText("1 down");
});

test("BMT award mix shows per-conduct taker counts", async ({ page }) => {
  await gotoIPPT(page);
  await openBMT(page);

  const card = page.locator(`${BMT} [data-ippt-card="awardmix"]`);
  await expect(card).toBeVisible();
  await expect(card.locator("h3")).toContainText("Award Mix by Conduct");
  await expect(card.locator("h3")).toContainText("BMT 1: 5");
  await expect(card.locator("h3")).toContainText("BMT 2: 4");
  await expect(card.locator("h3")).toContainText("BMT 3: 5");
  await expect(card.locator("#chart-ippt-bmt-awardmix")).toBeAttached();
});

test("adding a result files it under the phase picked in the form", async ({ page }) => {
  await gotoIPPT(page);
  await page.locator("button", { hasText: "+ Add" }).click();
  await expect(page.locator("#f-series")).toHaveValue("KH");
  await page.selectOption("#f-d4", "2402");
  await page.selectOption("#f-attempt", "1");
  await page.fill("#f-pu", "40"); await page.fill("#f-su", "40");
  await page.fill("#f-run-min", "11"); await page.fill("#f-run-sec", "30");
  await page.fill("#f-score", "72");
  await page.click('#modal-body button[type="submit"]');

  const added = await page.evaluate(() => STATE.ippt.filter((r) => r.d4 === "2402" && r.series === "KH"));
  expect(added.length).toBe(1);
  await expect(page.locator(`${KH} table tbody tr`)).toHaveCount(5);
  await expect(page.locator(`${KH} .card`, { hasText: "YTT Chase List" })).not.toContainText("BRAVO TWO");
});

test("a person's profile labels IPPTs by phase, BMT first", async ({ page }) => {
  await gotoIPPT(page);
  await page.evaluate(() => openPerson("1401"));
  const badges = page.locator("#modal-body .badge-accent", { hasText: /^(BMT|KH) \d/ });
  await expect(badges).toHaveCount(4);
  await expect(badges.first()).toContainText("BMT 1");
  await expect(badges.last()).toContainText("KH 1");
});
