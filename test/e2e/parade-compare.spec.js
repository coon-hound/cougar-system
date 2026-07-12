// Compare Parade States e2e: snapshot-on-copy, the inline compare flow in the
// FP report modal (newly-out card + strength delta), the standalone compare
// modal with pasted foreign text, and the raw-diff fallback for garbage.
// Fully offline (seeded localStorage, empty apiUrl) — the snapshot save path
// must never touch the network in this mode.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.beforeEach(async ({ page }) => {
  page.on("dialog", d => d.accept());   // headless clipboard is blocked → alert fallback
});

test("copying an FP state auto-saves a snapshot (before the clipboard attempt)", async ({ page }) => {
  await seedAndGoto(page);
  await page.locator("button", { hasText: "Generate Report" }).click();
  await page.locator("#report-menu button", { hasText: "First Parade State" }).click();
  await page.fill("#rep-time", "0700");
  await page.locator("button[type=submit]", { hasText: "Regenerate" }).click();
  await page.locator("#rep-copy-btn").click();

  const store = await page.evaluate(() => JSON.parse(localStorage.getItem("cougar-parade-snapshots") || "{}"));
  expect(store.snapshots.length).toBe(1);
  expect(store.snapshots[0].type).toBe("FP");
  expect(store.snapshots[0].time).toBe("0700");
  expect(store.snapshots[0].text).toContain("FIRST PARADE STATE");
  // Offline (no apiUrl): the row stays queued for a later push, never errors.
  expect(store.pendingIds).toEqual([store.snapshots[0].id]);

  // Double-tapping Copy with identical text must not create a phantom v2.
  await page.locator("#rep-copy-btn").click();
  const again = await page.evaluate(() => JSON.parse(localStorage.getItem("cougar-parade-snapshots") || "{}"));
  expect(again.snapshots.length).toBe(1);
});

test("inline compare in the FP modal: newly-out card + strength delta", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await seedAndGoto(page);

  // Yesterday's parade state (all present) becomes the base snapshot; then
  // 1401 goes on an away MC, which today's FP must report as newly out.
  await page.evaluate(() => {
    const iso = todayISO();
    saveParadeSnapshot("FP", iso, "0700", generateParadeStateText("FP", iso, "0700"));
    const d = isoToDisplayDate(iso);
    STATE.medical.push({ id: 990001, d4: "1401", date: d, reason: "HFMD", status: "MC", startDate: d, endDate: d, inCamp: false });
    saveLocal(); render();
  });

  await page.locator("button", { hasText: "Generate Report" }).click();
  await page.locator("#report-menu button", { hasText: "First Parade State" }).click();
  await page.locator("button", { hasText: "Compare with previous" }).click();

  // The saved snapshot is preselected as the base; run the compare.
  await expect(page.locator("#cmp-base-select option")).toHaveCount(1);
  await page.locator("button", { hasText: "🔍 Compare" }).click();

  const results = page.locator("#cmp-results");
  await expect(results.locator(".cmp-group-head", { hasText: "Newly listed" })).toBeVisible();
  const outCard = results.locator(".cmp-card-out");
  await expect(outCard).toContainText("1401");
  await expect(outCard).toContainText("HFMD");
  await expect(outCard.locator(".badge", { hasText: "ATTC" })).toBeVisible();
  // One extra body out of camp → CURRENT dropped by 1, styled red (guards
  // the badge() class contract — it prefixes "badge-" itself).
  await expect(results.locator(".cmp-summary")).toContainText("CURRENT");
  await expect(results.locator(".cmp-summary .badge.badge-red", { hasText: "-1" })).toBeVisible();
  await expect(outCard.locator(".badge.badge-red", { hasText: "ATTC" })).toBeVisible();

  await page.screenshot({ path: "test-results/parade-compare.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("standalone compare: pasted foreign text diffs best-effort", async ({ page }) => {
  await seedAndGoto(page);
  await page.locator("button", { hasText: "Generate Report" }).click();
  await page.locator("#report-menu button", { hasText: "Compare Parade States" }).click();

  // No snapshots seeded → both sides offer the paste hint; flip both to Paste.
  const cards = page.locator("#cmp-pickers .card");
  await cards.nth(0).locator("button", { hasText: "📋 Paste" }).click();
  await cards.nth(1).locator("button", { hasText: "📋 Paste" }).click();

  const foreign = (extra) => [
    "BRAVO COY", "FIRST PARADE STATE", "DATE: 100726 @ 0800",
    "RSO: 1", "1. PTE JOHN LIM 2345", "Reason: fever", extra
  ].filter(Boolean).join("\n");
  await page.fill("#cmp-base-paste", foreign());
  // Flipping the OTHER card's pill re-renders both pickers — the pasted base
  // text must survive (regression: re-render used to wipe paste drafts).
  await cards.nth(1).locator("button", { hasText: "📂 Saved" }).click();
  await cards.nth(1).locator("button", { hasText: "📋 Paste" }).click();
  await expect(page.locator("#cmp-base-paste")).toHaveValue(foreign());
  await page.fill("#cmp-neu-paste", foreign("2. REC TAN AH KOW C1234"));
  await page.locator("button", { hasText: "🔍 Compare" }).click();

  const results = page.locator("#cmp-results");
  await expect(results.locator(".cmp-card-out")).toContainText("1234");
  await expect(results.locator(".cmp-summary")).toContainText("best-effort");
  // The raw line diff is always available as the trust anchor.
  await expect(results.locator(".cmp-details summary", { hasText: "Raw text diff" })).toBeVisible();
});

test("garbage paste falls back to the raw text diff", async ({ page }) => {
  await seedAndGoto(page);
  await page.evaluate(() => openCompareModal());
  const cards = page.locator("#cmp-pickers .card");
  await cards.nth(0).locator("button", { hasText: "📋 Paste" }).click();
  await cards.nth(1).locator("button", { hasText: "📋 Paste" }).click();
  await page.fill("#cmp-base-paste", "hello there\ngeneral kenobi");
  await page.fill("#cmp-neu-paste", "hello there\nyou are a bold one");
  await page.locator("button", { hasText: "🔍 Compare" }).click();

  const results = page.locator("#cmp-results");
  await expect(results).toContainText("Couldn't read enough structure");
  // Raw diff auto-opens in fallback mode and shows the changed lines.
  await expect(results.locator(".cmp-details[open] .cmp-del")).toContainText("general kenobi");
  await expect(results.locator(".cmp-details[open] .cmp-add")).toContainText("you are a bold one");
});
