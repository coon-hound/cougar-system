// Usage telemetry, in a real browser, fully offline.
//
// What is actually worth proving here, as opposed to in the unit suite:
//
//  · CAPTURE PHASE. index.html puts onclick="event.stopPropagation()" on
//    .modal, so a bubble-phase listener would see nothing inside a modal —
//    which is exactly where the expensive tasks live. Only a real browser can
//    show that the capture listener does see it.
//  · TRANSPARENCY. The monkey-patched globals sit in front of the app's own
//    handlers. If a wrapper broke `this`, an argument or an exception, the app
//    would misbehave, so every test collects pageerror and asserts none.
//  · PRIVACY, end to end. The fixture roster is C1401… ; after driving the real
//    UI, nothing resembling a 4D or a name may exist anywhere in the stored
//    telemetry blob.
//  · The insights view renders from real recorded data, and says so honestly
//    when there is none.
//
// The suite runs with no network (STATE.authToken is empty, so the app boots
// from localStorage), and nothing here requires a flush to succeed: flushing is
// a no-op without a token, which is the offline behaviour we want anyway.
const path = require("path");
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

const USAGE_KEY = "cougar-usage-v1";

// index.html does not yet carry the two new <script> tags (the nav entry and
// the render() dispatch case are wired separately). Injecting them when they
// are absent makes this spec pass both before and after that wiring, and it
// exercises the same files in the same shared global scope either way.
async function gotoWithTelemetry(page) {
  await seedAndGoto(page);
  const wired = await page.evaluate(() => typeof TELEMETRY !== "undefined");
  if (!wired) {
    await page.addScriptTag({ path: path.join(__dirname, "../../js/render-usage.js") });
    await page.addScriptTag({ path: path.join(__dirname, "../../js/telemetry.js") });
  }
  await page.evaluate(() => TELEMETRY.clearLocal());
  return wired;
}

const storedBlob = (page) =>
  page.evaluate((k) => localStorage.getItem(k) || "", USAGE_KEY);

// Force the debounced save so the assertions read the persisted blob, not just
// the in-memory copy.
const flushToStorage = (page) => page.waitForTimeout(1400);

test("captures inline handler names, and never their arguments", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoWithTelemetry(page);

  await page.click('[data-nav="roster"]');
  await expect(page.locator("#content")).toContainText("Roster");
  // A row action in the roster table — an inline onclick carrying a 4D.
  const rowBtn = page.locator('#content [onclick^="openPerson("]').first();
  await rowBtn.click();
  await page.evaluate(() => closeModal());

  const days = await page.evaluate(() => TELEMETRY.localDays());
  const names = Object.values(days).flatMap((d) => Object.keys(d.features));
  expect(names).toContain("openPerson");
  expect(names).toContain("nav:roster");
  // The argument openPerson('1401') was called with is nowhere in the record.
  for (const n of names) expect(n, `descriptor "${n}" carries digits`).not.toMatch(/\d/);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("a click inside a modal is captured despite stopPropagation", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoWithTelemetry(page);

  // The Book Out modal is one of the expensive multi-step tasks, and every
  // click in it passes through .modal's onclick="event.stopPropagation()".
  await page.evaluate(() => openBookOutForm({}));
  await expect(page.locator("#modal-overlay")).toBeVisible();
  await page.locator('.modal [onclick^="setBookOutMode("]').first().click();

  const days = await page.evaluate(() => TELEMETRY.localDays());
  const names = Object.values(days).flatMap((d) => Object.keys(d.features));
  expect(names, "a bubble-phase listener would have missed this entirely")
    .toContain("setBookOutMode");

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("opening a form and closing it counts as an abandoned task", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoWithTelemetry(page);

  await page.evaluate(() => openBookOutForm({}));
  await expect(page.locator("#modal-overlay")).toBeVisible();
  await page.locator('.modal [onclick^="setBookOutMode("]').first().click();
  await page.locator(".modal-close").click();
  await expect(page.locator("#modal-overlay")).toBeHidden();

  const task = await page.evaluate(() => {
    const days = TELEMETRY.localDays();
    for (const d of Object.values(days)) if (d.tasks.book_out) return d.tasks.book_out;
    return null;
  });
  expect(task).not.toBeNull();
  expect(task.starts).toBe(1);
  expect(task.aban).toBe(1);
  expect(task.done).toBe(0);
  // The tap that opened the form plus the tap inside it: a real click cost, not
  // a count that starts at zero once the form is already open.
  expect(task.clicks).toBeGreaterThanOrEqual(2);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("switching views records dwell without disturbing the app", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoWithTelemetry(page);

  for (const nav of ["roster", "medical", "ippt", "dashboard"]) {
    await page.click(`[data-nav="${nav}"]`);
    await page.waitForTimeout(60);
  }
  // The app itself still works — render() is wrapped, so this is the check that
  // the wrapper did not change what render does.
  await expect(page.locator("#content h2")).toContainText("Company Strength Board");

  const views = await page.evaluate(() => {
    const out = {};
    for (const d of Object.values(TELEMETRY.localDays())) {
      for (const [k, v] of Object.entries(d.views)) out[k] = (out[k] || 0) + v.n;
    }
    return out;
  });
  expect(Object.keys(views)).toEqual(expect.arrayContaining(["roster", "medical", "ippt"]));

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("nothing personal reaches the stored telemetry blob", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoWithTelemetry(page);

  // Drive the parts of the app that are richest in personal data.
  await page.click('[data-nav="roster"]');
  await page.locator('#content [onclick^="openPerson("]').first().click();
  await page.evaluate(() => closeModal());
  await page.click('[data-nav="medical"]');
  await page.evaluate(() => openBookOutForm({}));
  await page.evaluate(() => closeModal());
  await flushToStorage(page);

  const blob = await storedBlob(page);
  expect(blob.length).toBeGreaterThan(0);

  // Every 4D in the fixture, and the names that go with them.
  const seeded = await page.evaluate(() =>
    STATE.roster.flatMap((r) => [r.id, r["4d"], r.name].filter(Boolean)));
  for (const needle of seeded) {
    expect(blob, `telemetry blob leaked "${needle}"`).not.toContain(needle);
  }
  // And no bare 4-digit run of any kind outside the millisecond timestamps.
  const names = await page.evaluate(() => {
    const out = [];
    for (const d of Object.values(TELEMETRY.localDays())) {
      out.push(...Object.keys(d.features), ...Object.keys(d.views), ...Object.keys(d.tasks));
    }
    return out;
  });
  for (const n of names) expect(n).not.toMatch(/\d/);

  // The device id is a hash, not the credential.
  const [deviceId, authToken] = await page.evaluate(() =>
    [TELEMETRY.deviceId(), localStorage.getItem("cougar-auth") || ""]);
  expect(deviceId).toBeTruthy();
  if (authToken) expect(authToken).not.toContain(deviceId);

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("the insights view is honest when there is nothing to show", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoWithTelemetry(page);

  await page.evaluate(() => {
    TELEMETRY.clearLocal();
    renderUsage(document.getElementById("content"));
  });
  const content = page.locator("#content");
  await expect(content).toContainText("No usage recorded yet");
  // A zero must never be presented as a finding.
  await expect(content).toContainText("A zero here means no measurement, not zero usage");
  await expect(content.locator(".empty-state")).toBeVisible();

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("the insights view ranks cost and states a recommendation", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await gotoWithTelemetry(page);

  // Real usage, recorded through the real collector: open and abandon Book Out
  // three times, then a handful of view switches.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => openBookOutForm({}));
    await page.locator('.modal [onclick^="setBookOutMode("]').first().click();
    await page.locator('.modal [onclick^="setBookOutMode("]').nth(1).click();
    await page.locator(".modal-close").click();
  }
  await page.click('[data-nav="roster"]');
  await page.click('[data-nav="dashboard"]');

  await page.evaluate(() => renderUsage(document.getElementById("content")));
  const content = page.locator("#content");

  await expect(content.locator("h2")).toContainText("Usage Insights");
  await expect(content).toContainText("Clicks per task");
  await expect(content).toContainText("Book Out");
  await expect(content).toContainText("Views opened");
  // Three opens, none finished: a leak, and the view must say so in words
  // rather than leaving it to be read off a table.
  await expect(content).toContainText("the form is losing people");
  await expect(content.locator(".badge-orange").first()).toBeVisible();

  // The toggle is present and stays on this device while offline.
  await expect(content.locator(".role-btn", { hasText: "This device" })).toHaveClass(/active/);
  await expect(content.locator(".role-btn", { hasText: "Company" })).toBeVisible();

  await page.screenshot({ path: "test-results/telemetry.png", fullPage: true });
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
