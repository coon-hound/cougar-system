// Smaller tap savings from the same usage data: named search hits, the
// one-tap report button, Book Out remembering its toggles, and the Roster's
// rarely-used buttons moved behind ⋯.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test("search: hits show the name, Enter opens the top one and clears the search", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAndGoto(page);
  const r = await page.evaluate(() => STATE.roster.find((x) => x.role !== "Commander" && x.name));

  // Empty results take no room, so the field keeps its width on a phone.
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("search-results")).display)).toBe("none");

  await page.fill("#search-input", r.id);
  await expect(page.locator("#search-results button").first()).toContainText(r.name);
  await page.screenshot({ path: "test-results/fewer-taps-search.png" });
  await page.press("#search-input", "Enter");
  await expect(page.locator("#modal-overlay")).not.toHaveClass(/hidden/);
  await expect(page.locator("#modal-title")).toContainText(r.name);
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect(page.locator("#search-results")).toBeEmpty();
});

test("report: the left button opens the due parade state, or the last other report", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-22T07:30:00"));
  await seedAndGoto(page);
  const quick = page.locator('#content button[data-tel$=":quick"]');
  await expect(quick).toHaveText("First Parade");
  await quick.click();
  await expect(page.locator("#modal-title")).toHaveText("Generate First Parade State");
  await page.evaluate(() => closeModal());

  // A parade state used this morning does not make the evening button say FP.
  await page.clock.setFixedTime(new Date("2026-10-22T17:30:00"));
  await page.evaluate(() => render());
  await expect(quick).toHaveText("Last Parade");

  // A non-parade report is remembered on this device.
  await page.locator('#content button[aria-label="All reports"]').click();
  await page.locator("#report-menu button", { hasText: "Medical Status List" }).click();
  await page.evaluate(() => closeModal());
  await page.reload();
  await expect(page.locator('#content button[data-tel$=":quick"]')).toHaveText("Medical List");
});

test("book out: opens on the mode and scope this device used last", async ({ page }) => {
  await seedAndGoto(page);
  await page.evaluate(() => openBookOutForm());
  await expect(page.locator("#f-bo-mode")).toHaveValue("today");
  await page.locator("#f-bo-scope").selectOption("plt:1");
  await page.evaluate(() => onBookOutScopeChange());
  await page.evaluate(() => setBookOutMode("range"));
  await page.locator("#f-bo-type").selectOption("Course");
  await page.locator("#f-bo-submit").click();
  await page.evaluate(() => closeModal());

  await page.reload();
  await page.evaluate(() => openBookOutForm());
  await expect(page.locator("#f-bo-scope")).toHaveValue("plt:1");
  await expect(page.locator("#f-bo-mode")).toHaveValue("range");
  await page.evaluate(() => closeModal());

  // A scope that no longer exists falls back to one person.
  await page.evaluate(() => localStorage.setItem("cougar-bookout-last", JSON.stringify({ mode: "today", scope: "grp:Gone" })));
  await page.evaluate(() => openBookOutForm());
  await expect(page.locator("#f-bo-scope")).toHaveValue("person");
  await expect(page.locator("#f-bo-mode")).toHaveValue("today");
});

test("roster: + Commander and Groups live behind ⋯", async ({ page }) => {
  await seedAndGoto(page);
  await page.click('.nav-btn[data-nav="roster"]');
  const menu = page.locator("#roster-menu");
  await expect(menu).toBeHidden();
  await expect(page.locator("#content > div > div > button", { hasText: "+ Commander" })).toHaveCount(0);
  await page.locator('#content button[aria-label="More roster actions"]').click();
  await expect(menu).toBeVisible();
  // Opening one menu closes on an outside tap.
  await page.locator("#content h2").click();
  await expect(menu).toBeHidden();
  await page.locator('#content button[aria-label="More roster actions"]').click();
  await menu.locator("button", { hasText: "Groups" }).click();
  await expect(page.locator("#modal-overlay")).not.toHaveClass(/hidden/);
  await expect(menu).toBeHidden();
});
