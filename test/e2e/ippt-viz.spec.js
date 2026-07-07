// IPPT multi-attempt visualizations — with IPPT 3 in play, the old fixed
// "IPPT 1 vs IPPT 2" charts stopped meaning anything. These specs cover the
// generalized replacements over the seeded 3-conduct fixture data:
//   · Score Progression (one line per recruit across all conducts)
//   · Compare Conducts (any-pair scatter + biggest movers, default first→latest)
//   · Award Mix by Conduct (100% stacked tier bars)
//
// Fixture cohort (see fixtures/demo-seed.json "ippt"):
//   C1401 60→70→85 (+25, top improver)   C1402 65→72→78
//   C1403 80→74→70 (−10, only decliner)  C2401 75→68→76
//   C2402 55→ — →62 (missed IPPT 2)      C2403 YTT (all-zero row, excluded)
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

async function gotoIPPT(page) {
  await seedAndGoto(page);
  await page.click('[data-nav="ippt"]');
  await expect(page.locator("h2", { hasText: "IPPT Tracker" })).toBeVisible();
}

test("conduct filter offers every seeded IPPT, including IPPT 3", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoIPPT(page);

  for (const n of [1, 2, 3]) {
    await expect(page.locator(".role-btn", { hasText: `IPPT ${n}` }).first()).toBeVisible();
  }
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("score progression card renders across all conducts", async ({ page }) => {
  await gotoIPPT(page);

  const card = page.locator('[data-ippt-card="progression"]');
  await expect(card).toBeVisible();
  await expect(card.locator("h3")).toContainText("Score Progression");
  await expect(card.locator("#chart-ippt-progress")).toBeAttached();
});

test("compare card defaults to first vs latest conduct with correct cohort and movers", async ({ page }) => {
  await gotoIPPT(page);

  const card = page.locator('[data-ippt-card="compare"]');
  await expect(card).toBeVisible();
  // Default pair spans the whole journey: IPPT 1 → IPPT 3 (not the stale 1 → 2).
  await expect(card.locator("h3").first()).toContainText("IPPT 1 → IPPT 3");
  // 5 recruits have valid scores in both 1 and 3 (C2403's YTT row never counts);
  // 4 improved, 1 declined.
  await expect(card.locator("h3").first()).toContainText("5 took both");
  await expect(card.locator("h3").first()).toContainText("4 up");
  await expect(card.locator("h3").first()).toContainText("1 down");
  await expect(card.locator("#chart-ippt-scatter")).toBeAttached();

  // Biggest movers over the compared pair: ALPHA ONE +25 tops the improvers,
  // ALPHA THREE is the only drop.
  const improved = card.locator("div", { has: page.locator("h3", { hasText: "Most improved" }) }).last();
  await expect(improved).toContainText("ALPHA ONE");
  await expect(improved).toContainText("+25");
  const drops = card.locator("div", { has: page.locator("h3", { hasText: "Biggest drops" }) }).last();
  await expect(drops).toContainText("ALPHA THREE");
  await expect(drops).toContainText("80 → 70");
});

test("any conduct pair is selectable — IPPT 2 → 3 recomputes the cohort", async ({ page }) => {
  await gotoIPPT(page);

  // All three pairs are offered for 3 conducts.
  const card = page.locator('[data-ippt-card="compare"]');
  for (const label of ["IPPT 1 → 2", "IPPT 1 → 3", "IPPT 2 → 3"]) {
    await expect(card.locator(".role-btn", { hasText: label })).toBeVisible();
  }

  await card.locator(".role-btn", { hasText: "IPPT 2 → 3" }).click();
  const after = page.locator('[data-ippt-card="compare"]');
  await expect(after.locator("h3").first()).toContainText("IPPT 2 → IPPT 3");
  // C2402 missed IPPT 2, so the paired cohort shrinks to 4 (3 up, 1 down).
  await expect(after.locator("h3").first()).toContainText("4 took both");
  await expect(after.locator("h3").first()).toContainText("3 up");
  await expect(after.locator("h3").first()).toContainText("1 down");
});

test("award mix card shows per-conduct taker counts", async ({ page }) => {
  await gotoIPPT(page);

  const card = page.locator('[data-ippt-card="awardmix"]');
  await expect(card).toBeVisible();
  await expect(card.locator("h3")).toContainText("Award Mix by Conduct");
  // Valid takers per conduct: IPPT 1 = 5, IPPT 2 = 4 (C2402 missed it), IPPT 3 = 5.
  await expect(card.locator("h3")).toContainText("IPPT 1: 5");
  await expect(card.locator("h3")).toContainText("IPPT 2: 4");
  await expect(card.locator("h3")).toContainText("IPPT 3: 5");
  await expect(card.locator("#chart-ippt-awardmix")).toBeAttached();
});
