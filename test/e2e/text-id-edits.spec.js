// ============================================================================
// Editing an existing record must UPDATE IN PLACE, never append a duplicate.
//
// This is the third silent bug of the Sheets -> Postgres migration, and the
// most destructive. Sheets typed the id column as a NUMBER, so the client got
// away with `const editId = +gv("f-entry-id")` and compared `row.id === editId`.
// Postgres types every column as TEXT (0001_init.sql), so the same row now
// arrives with id "1404". `"1404" === 1404` is false, so:
//
//   * submitMedical  falls through its edit branch and PUSHES the record again
//                    - one edit, two rows, both claiming the same id.
//   * submitIPPT /   find nothing to assign to, so the user's edit is silently
//     submitLeave    DISCARDED - the form closes as if it saved.
//
// Verified against the real backend before the fix: editing one medical record
// took the Medical tab from 12 rows to 13.
//
// Why this got through 122 unit + 41 e2e tests: every fixture in the repo
// seeded readable ids like "md-01". `+"md-01"` is NaN, which is FALSY, so the
// forms took the "this is a new record" branch - a different code path from
// production entirely. These specs therefore insist on production-shaped
// NUMERIC-STRING ids ("1404"), the only shape that reproduces the bug.
//
// Reintroducing the `+` in js/forms.js must make every test in this file fail.
// ============================================================================

const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// The shape the live sheet actually holds: 4-digit counter ids, handed back by
// a text-typed backend as strings. `+ID` is a truthy number, `ID === +ID` is
// false - which is the whole trap.
const MED_ID = "1404";
const LEAVE_ID = "2517";

test.beforeEach(async ({ page }) => {
  await seedAndGoto(page);
  // Any pageerror fails the spec: the id fix also required quoting 20 inline
  // onclick handlers (openMedicalForm(${m.id}) -> openMedicalForm('${m.id}')),
  // and an unquoted one throws ReferenceError on a string id.
  page.on("pageerror", (e) => { throw e; });
});

// A medical record dated today, seeded exactly as a pull would leave it.
async function seedMedical(page) {
  await page.evaluate((id) => {
    const disp = (d) => {
      const x = new Date(todayISO()); x.setUTCDate(x.getUTCDate() + d);
      return isoToDisplayDate(x.toISOString().slice(0, 10));
    };
    STATE.medical.push({
      id, d4: "1401", date: disp(0), reason: "Back pain", location: "",
      status: "MC", startDate: disp(0), endDate: disp(2), inCamp: false,
    });
    saveLocal(); render();
  }, MED_ID);
}

test("editing a medical record updates it in place - it does not append a duplicate", async ({ page }) => {
  await seedMedical(page);
  await page.click('.nav-btn[data-nav="medical"]');

  const row = page.locator("#content table tr", { hasText: "Back pain" }).first();
  await row.locator('button[title="Edit"]').click();

  // The form must carry the id as TEXT, exactly as the row holds it.
  await expect(page.locator("#f-entry-id")).toHaveValue(MED_ID);

  await page.fill("#f-reason", "Back pain (reviewed)");
  await page.click('#modal-body button[type="submit"]');

  const med = await page.evaluate(() => STATE.medical);
  expect(med.length, "one edit must leave exactly one record").toBe(1);
  expect(med[0].id).toBe(MED_ID);
  expect(med[0].reason).toBe("Back pain (reviewed)");

  // And the list shows one row, not two identical ones.
  await expect(page.locator("#content table tr", { hasText: "Back pain (reviewed)" })).toHaveCount(1);
});

test("editing an IPPT result updates it in place - the edit is not silently dropped", async ({ page }) => {
  // Straight from the fixture, whose ids are numeric strings ("7001").
  const id = await page.evaluate(() => STATE.ippt[0].id);
  expect(id, "the fixture must hold production-shaped numeric-string ids").toMatch(/^\d+$/);

  await page.click('.nav-btn[data-nav="ippt"]');
  // The IPPT tab opens on a chart view; the per-attempt table is the one with
  // an Edit button, so pick the first row that has one.
  const row = page.locator("#content table tr", { has: page.locator('button[title="Edit"]') }).first();
  await row.locator('button[title="Edit"]').click();

  await expect(page.locator("#f-entry-id")).toHaveValue(String(id));
  const editedId = await page.evaluate(() => gv("f-entry-id"));

  await page.fill("#f-pu", "44");
  await page.click('#modal-body button[type="submit"]');

  const state = await page.evaluate(() => STATE.ippt);
  const hit = state.filter((r) => r.id === editedId);
  expect(hit.length, "no duplicate row").toBe(1);
  expect(hit[0].pushups, "the edit actually landed").toBe(44);
});

test("editing a leave record updates it in place", async ({ page }) => {
  await page.evaluate((id) => {
    const disp = (d) => {
      const x = new Date(todayISO()); x.setUTCDate(x.getUTCDate() + d);
      return isoToDisplayDate(x.toISOString().slice(0, 10));
    };
    STATE.leave.push({
      id, d4: "1402", type: "Annual Leave",
      startDate: disp(0), endDate: disp(1), days: 2, reason: "Family",
    });
    saveLocal(); render();
  }, LEAVE_ID);

  await page.click('.nav-btn[data-nav="leave"]');
  const row = page.locator("#content table tr", { hasText: "Family" }).first();
  await row.locator('button[title="Edit"]').click();

  await expect(page.locator("#f-entry-id")).toHaveValue(LEAVE_ID);

  await page.fill("#f-reason", "Family (rescheduled)");
  await page.click('#modal-body button[type="submit"]');

  const leave = await page.evaluate(() => STATE.leave);
  expect(leave.length, "one edit must leave exactly one record").toBe(1);
  expect(leave[0].id).toBe(LEAVE_ID);
  expect(leave[0].reason).toBe("Family (rescheduled)");
});

test("a text id survives the read boundary and the inline row handlers", async ({ page }) => {
  // The other half of the fix: normId (js/state.js) stringifies ids on read, so
  // a backend that still types the column as a NUMBER cannot hand the app an id
  // that breaks `===` later. And render.js quotes every id it interpolates into
  // an onclick, so a string id is not a ReferenceError.
  await page.evaluate(() => {
    STATE.medical.push({ id: 1404, d4: "1401", date: "01 Jul 2026", reason: "Numeric id from the wire", status: "LD", startDate: "01 Jul 2026", endDate: "03 Jul 2026" });
    saveLocal();
  });
  // loadLocal() is the read boundary itself - the same call the bootstrap makes
  // (a page.reload() would not do: support.js re-seeds localStorage on every
  // navigation and would wipe the row).
  await page.evaluate(() => { loadLocal(); render(); });

  const ids = await page.evaluate(() => STATE.medical.map((m) => typeof m.id));
  expect(ids).toEqual(["string"]);

  // Clicking the row's Edit button executes the inline handler for real.
  await page.click('.nav-btn[data-nav="medical"]');
  const row = page.locator("#content table tr", { hasText: "Numeric id from the wire" }).first();
  await row.locator('button[title="Edit"]').click();
  await expect(page.locator("#f-entry-id")).toHaveValue("1404");
});
