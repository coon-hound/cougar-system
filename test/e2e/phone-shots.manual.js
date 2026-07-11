// Manual phone-width (375px) screenshot pass for the Compare feature.
// Not a *.spec.js — run on demand: node test/e2e/phone-shots.manual.js
// (starts its own chromium against the static server port passed via PW_PORT
// or 5599; run `python3 -m http.server 5599` first if not already running).
const { chromium } = require("@playwright/test");
const path = require("path");
const seed = require("./fixtures/demo-seed.json");

(async () => {
  const port = process.env.PW_PORT || 5599;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  page.on("dialog", d => d.accept());
  const entries = Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]);
  await page.addInitScript(pairs => { for (const [k, v] of pairs) localStorage.setItem(k, v); }, entries);
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForFunction(() => typeof STATE !== "undefined" && Array.isArray(STATE.roster));
  await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });

  // Seed a base snapshot, then put one recruit on MC so the diff has content.
  await page.evaluate(() => {
    const iso = todayISO();
    saveParadeSnapshot("FP", iso, "0700", generateParadeStateText("FP", iso, "0700"));
    const d = isoToDisplayDate(iso);
    STATE.medical.push({ id: 990001, d4: "1401", date: d, reason: "HFMD", status: "MC", startDate: d, endDate: d, inCamp: false });
    STATE.leave.push({ id: 990002, d4: "2402", type: "Annual Leave", startDate: d, endDate: d, reason: "family", days: 1 });
    saveLocal(); render();
  });

  await page.evaluate(() => openReportModal("FP"));
  await page.locator("button", { hasText: "Compare with previous" }).click();
  await page.screenshot({ path: "test-results/phone-375-compare-picker.png", fullPage: true });
  await page.locator("button", { hasText: "🔍 Compare" }).click();
  await page.waitForSelector("#cmp-results .cmp-summary");
  await page.screenshot({ path: "test-results/phone-375-compare-results.png", fullPage: true });

  // Horizontal-scroll check: document must not be wider than the viewport.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log("horizontal overflow px:", overflow);

  // Raw diff open state.
  await page.locator(".cmp-details summary", { hasText: "Raw text diff" }).click();
  await page.screenshot({ path: "test-results/phone-375-raw-diff.png", fullPage: true });

  // Standalone modal, paste mode.
  await page.evaluate(() => { closeModal(); openCompareModal(); });
  await page.screenshot({ path: "test-results/phone-375-standalone.png", fullPage: true });

  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log("horizontal overflow px (standalone):", overflow2);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
