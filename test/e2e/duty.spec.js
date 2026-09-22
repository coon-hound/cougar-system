// The duty schedule, in a real browser against the seeded fixture.
//
// Two things are worth pinning here and nowhere else: that a commander and the
// company admin get DIFFERENT screens rather than the same one with controls
// removed, and that the month view stays inside 390px - the grid it replaces
// could not, which is the whole reason this shape exists.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// This spec seeds its OWN command body and duty rows. The fixture is shared by
// every spec in the suite, and reshaping its roster to suit this feature broke
// thirteen of them - rank ordering, commander platoons and a leave edit all
// assert on exactly what is in there.
const SEED_DUTY = () => {
  const iso = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const weekend = (s) => [0, 6].includes(new Date(s + "T00:00:00").getDay());

  STATE.roster = STATE.roster.filter((r) => r.role !== "Commander").concat([
    { id: "0001", name: "COMD TAN", role: "Commander", rank: "3SG", plt: "1",
      appt: "VC", oilTracked: "true", leaveQuota: "14", openingOilUsed: "2", openingAlUsed: "0" },
    { id: "0002", name: "DELTA LIM", role: "Commander", rank: "2SG", plt: "1",
      appt: "SC", oilTracked: "true", leaveQuota: "14", openingOilUsed: "0", openingAlUsed: "1" },
    { id: "0003", name: "ECHO WONG", role: "Commander", rank: "3SG", plt: "2",
      appt: "SC", oilTracked: "true", leaveQuota: "", openingOilUsed: "0", openingAlUsed: "0" },
    // Deliberately outside the off system, like four of the real twenty-four.
    { id: "0004", name: "FOXTROT NG", role: "Commander", rank: "2SG", plt: "2",
      appt: "VC", oilTracked: "", leaveQuota: "14", openingOilUsed: "0", openingAlUsed: "0" },
  ]);
  STATE.oilRule = [
    { id: "oil-arr-ALL", event: "ARR", appliesTo: "ALL", days: "1", notes: "" },
    { id: "oil-panzer-VC", event: "PANZER", appliesTo: "VC", days: "4", notes: "" },
    { id: "oil-panzer-SC", event: "PANZER", appliesTo: "SC", days: "2", notes: "" },
  ];
  STATE.leave = [{ id: "5001", d4: "0002", type: "Off-in-Lieu",
                   startDate: "", endDate: "", days: "1", reason: "" }];
  const rows = [];
  for (let n = -2; n < 6; n++) {
    const date = iso(n);
    if (weekend(date)) continue;
    // 0002 and 0004 are the 2SGs: CDS is theirs and PDS is not. Seeding a 2SG
    // onto a PDS slot would have the screen contradict the rule it enforces.
    [["CDO", "", "0004"], ["CDS", "", "0002"], ["COS", "", "0004"],
     ["PDS", "1", "0001"], ["PDS", "2", "0003"]].forEach(([role, slot, d4]) => {
      // One COS left unfilled a couple of days out, so the coverage figure and
      // the gap pip have something real to report.
      if (role === "COS" && n === 2) return;
      rows.push({ id: `duty-${date}-${role}${slot}`, date, role, slot, d4,
                  status: "published", source: "manual", note: "" });
    });
  }
  STATE.duty = rows;
};

const asReader = () => {
  STATE.me = { d4: "0001", canEditDuty: false };
  STATE.nav = "duty";
  render();
};
const asAdmin = () => {
  STATE.me = { d4: "0001", canEditDuty: true };
  STATE.nav = "duty";
  render();
};

async function gotoDuty(page, who) {
  await seedAndGoto(page);
  await page.evaluate(SEED_DUTY);
  await page.evaluate(who);
  await expect(page.locator("#content")).toBeVisible();
}

test("a commander sees the WHOLE schedule, with his own duty leading it", async ({ page }) => {
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await gotoDuty(page, asReader);

  // His own duty leads the screen - that is the question most people bring to
  // this tab - but it does not replace the schedule. He has to be able to see
  // the roster he is on and who has the platoon tomorrow.
  await expect(page.locator(".dty-mine")).toBeVisible();
  await expect(page.locator(".dty-strip-day")).toHaveCount(7);
  await expect(page.locator(".dty-seg")).toBeVisible();
  await expect(page.locator(".dty-ro")).toHaveText("READ ONLY");

  await page.evaluate(() => setDutyMode("month"));
  await expect(page.locator(".dty-mgrid").first()).toBeVisible();
  expect(await page.locator(".dty-mcell:not(.is-blank)").count()).toBeGreaterThan(27);

  await page.evaluate(() => setDutyMode("people"));
  expect(await page.locator(".dty-bal").count()).toBeGreaterThan(0);
  expect(errs).toEqual([]);
});

test("duty counts are open to everyone; another man's leave balance is not", async ({ page }) => {
  // How the load is shared out is the fairness question, and hiding it is how
  // a roster stops being trusted. How much leave another man has left is
  // personnel data - the rest of this app encrypts that class of column.
  await gotoDuty(page, asReader);
  await page.evaluate(() => setDutyMode("people"));

  const body = await page.locator("#content").innerText();
  expect(body).toContain("PDS");                       // tallies are visible
  // 0001 is who this token says we are, so his own balance shows.
  const ledgers = await page.locator(".dty-bal-led").count();
  expect(ledgers).toBe(1);

  // The admin sees every one of them.
  await page.evaluate(asAdmin);
  await page.evaluate(() => setDutyMode("people"));
  expect(await page.locator(".dty-bal-led").count()).toBeGreaterThan(1);
});

test("identity comes from the access code, with no way to claim someone else", async ({ page }) => {
  // The invite issues one token per person and auth_tokens carries their 4D,
  // so the app already knows who this is. There is deliberately no picker: on
  // this screen a self-declared identity means reading another commander's
  // duties and off balances by choosing his name.
  await gotoDuty(page, asReader);
  await expect(page.locator(".dty-mine-who")).toContainText("COMD TAN");
  expect(await page.locator("#content select").count()).toBe(0);

  // A token that names somebody else shows THEIR duties, not a choice.
  await page.evaluate(() => { STATE.me = { d4: "0003", canEditDuty: false }; render(); });
  await expect(page.locator(".dty-mine-who")).toContainText("ECHO WONG");

  // A token that resolves to nobody explains itself rather than offering a list.
  await page.evaluate(() => { STATE.me = { d4: "", canEditDuty: false }; render(); });
  await expect(page.locator(".dty-ask")).toBeVisible();
  expect(await page.locator("#content select").count()).toBe(0);
});

test("an offline launch still knows who is holding the phone", async ({ page }) => {
  // whoami needs the network. The cache is the SERVER's last answer, written
  // only on a successful whoami, so it is identity, not a self-declaration.
  await gotoDuty(page, asReader);
  await page.evaluate(() => {
    cacheIdentity({ d4: "0002", person: "DELTA LIM", canEditDuty: false });
    STATE.me = undefined;          // as it is when whoami cannot be reached
    render();
  });
  await expect(page.locator(".dty-mine-who")).toContainText("DELTA LIM");

  // An admin offline keeps the planner rather than being silently demoted to
  // the read-only screen. A stale yes is harmless - the server still refuses
  // the write - while a stale no would lock him out of his own job.
  await page.evaluate(() => {
    cacheIdentity({ d4: "0001", person: "COMD TAN", canEditDuty: true });
    STATE.me = undefined;
    render();
  });
  await expect(page.locator(".dty-seg")).toBeVisible();
});

test("a non-admin cannot reach an edit control, even on today's team", async ({ page }) => {
  await gotoDuty(page, asReader);
  // The slot rows render, but as text rather than buttons.
  await expect(page.locator(".dty-slot").first()).toBeVisible();
  expect(await page.locator("button.dty-slot").count()).toBe(0);
});

test("the admin gets the planner, and the month stays inside a phone", async ({ page }) => {
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await gotoDuty(page, asAdmin);

  await expect(page.locator(".dty-seg")).toBeVisible();
  await expect(page.locator("button.dty-slot").first()).toBeVisible();

  await page.evaluate(() => setDutyMode("month"));
  await expect(page.locator(".dty-mgrid").first()).toBeVisible();
  // One cell per day, seven to a row, with coverage carried by pips. A cell
  // cannot name five holders; tapping it opens the day, which can.
  expect(await page.locator(".dty-mcell:not(.is-blank)").count()).toBeGreaterThan(27);
  expect(await page.locator(".dty-mpip").count()).toBeGreaterThan(0);

  // THE assertion this whole layout exists for.
  for (const mode of ["today", "month", "people"]) {
    await page.evaluate((m) => setDutyMode(m), mode);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, `${mode} must not scroll sideways at 390px`).toBeLessThanOrEqual(0);
  }
  expect(errs).toEqual([]);
});

test("assigning a duty writes one row, and re-assigning the slot replaces it", async ({ page }) => {
  await gotoDuty(page, asAdmin);
  const date = await page.evaluate(() => STATE.duty[0].date);

  await page.evaluate((d) => openDutySlot(d, "COS"), date);
  await expect(page.locator(".dty-pick").first()).toBeVisible();

  const before = await page.evaluate(() => STATE.duty.length);
  await page.evaluate((d) => setDutySlot(d, "COS", "0004"), date);
  const after = await page.evaluate(() => ({
    len: STATE.duty.length,
    row: STATE.duty.find((r) => r.role === "COS" && r.date === STATE.duty[0].date),
    holder: dutyForDate(STATE.duty[0].date).COS,
  }));
  // The slot already existed in the fixture, so this replaces rather than adds.
  expect(after.len).toBe(before);
  expect(after.holder).toBe("0004");
});

test("the balances view separates the two ledgers and names who is not tracked", async ({ page }) => {
  await gotoDuty(page, asAdmin);
  await page.evaluate(() => setDutyMode("people"));

  const body = await page.locator("#content").innerText();
  expect(body).toContain("OIL");
  expect(body).toContain("AL");
  // One fixture commander is deliberately outside the off system. He must read
  // as untracked rather than as a man who has taken everything.
  expect(body.toLowerCase()).toContain("not in the off system");
});

test("the picker shows unavailable commanders WITH the reason", async ({ page }) => {
  await gotoDuty(page, asAdmin);
  const date = await page.evaluate(() => STATE.duty[0].date);
  await page.evaluate((d) => openDutySlot(d, "CDS"), date);

  // Hiding a man reads as the app having lost him; the admin sometimes knows
  // the record is wrong and overrides it on purpose.
  await expect(page.locator(".dty-pick.is-unavail").first()).toBeVisible();
  const txt = await page.locator(".dty-picklist").innerText();
  expect(txt).toMatch(/not a 2SG|already on duty|away|on MC|platoon/i);
});
