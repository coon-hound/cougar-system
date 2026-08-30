// ============================================================================
// The backend contract, asserted through the real UI in a real browser.
//
// These specs exist for the Google Sheets → Postgres migration. They pin the
// behaviour the replacement backend must reproduce, and several of them assert
// bugs that the Apps Script backend HAD - so they double as the acceptance
// criteria for the new one.
//
// They run against ./fake-backend.js, which implements the protocol faithfully.
// That means they prove two different things:
//   * what the CLIENT puts on the wire (contract for the Edge Function), and
//   * how the client BEHAVES when the backend answers correctly.
// ============================================================================

const { test, expect } = require("@playwright/test");
const { seedAndGoto, SEED } = require("./support");
const { makeBackend } = require("./fake-backend");

// Mirrors padD4 (js/state.js:284): the client canonicalises every 4D on read,
// so the ids it sends back are digit-only. The backend seed has to match, or
// upserts would look like appends.
const padD4 = (v) => {
  const s = String(v ?? "").trim().replace(/^C/i, "");
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
};

// Backend Roster built from the same fixture the client boots from. Note it
// carries NO extra column: the client does a full pullAll on launch, so
// anything seeded here is something the client then knows about. The stale-model
// asymmetry has to be introduced after that pull - see the partial-upsert spec.
function rosterSeed(extra = {}) {
  return SEED["cougar-data-v2"].roster.map((r) => ({ ...r, id: padD4(r.id), ...extra }));
}

async function bootAuthed(page, opts = {}) {
  const backend = makeBackend(opts);
  await backend.install(page);
  await page.addInitScript(() => localStorage.setItem("cougar-auth", "e2e-token"));
  await seedAndGoto(page);
  return backend;
}

// Book out one person through the real UI. Returns nothing; assertions read
// the backend afterwards.
async function bookOutOnePerson(page, reason = "MO") {
  await page.click(`.nav-btn[data-nav="dashboard"]`);
  await page.click("text=+ Book Out");
  await page.selectOption("#f-bo-scope", "person");
  await page.selectOption("#f-bo-d4", { index: 1 });
  await page.fill("#f-bo-reason", reason);
  await page.click("#f-bo-submit");
}

test("the app talks to whatever cougar-api-url points at (the cutover lever)", async ({ page }) => {
  // Nothing here mentions script.google.com. If the override did not work the
  // app would reach the real production URL, no route would match, and the
  // backend would see zero requests.
  const backend = await bootAuthed(page);
  await expect.poll(() => backend.requests.length).toBeGreaterThan(0);
  expect(backend.requests.every((r) => r.url.startsWith(backend.API_URL))).toBe(true);

  // And it is a genuine per-device override, not a build-time constant.
  expect(await page.evaluate(() => STATE.apiUrl)).toBe(backend.API_URL);
});

test("a partial upsert must not blank columns the client never sent", async ({ page }) => {
  // THE flagship bug. The old upsertRow (apps-script-Code.gs:1105-1108) rebuilt
  // the row from every current header and wrote "" for anything missing from
  // the payload, so a device with a stale model silently erased campIn /
  // groups / location / program on an unrelated save.
  //
  // Here the backend holds `location`, the client's cache does not, and the
  // client saves something else entirely.
  const backend = await bootAuthed(page, { seed: { Roster: rosterSeed() } });
  page.on("dialog", (d) => d.accept());

  // Let the launch pull settle, so the client's model is fixed ...
  await expect.poll(() => page.evaluate(() => STATE.rev && STATE.rev.Roster)).toBeTruthy();

  // ... then give the backend a column the client has never seen, WITHOUT
  // bumping the revision. That is precisely a device running a stale model:
  // another client (or a schema addition) wrote a field this one knows nothing
  // about, and this one has not refreshed.
  for (const r of backend.rows("Roster")) r.location = "Tekong";
  const before = backend.rows("Roster").filter((r) => r.location === "Tekong").length;
  expect(before).toBeGreaterThan(0);

  await bookOutOnePerson(page);
  await expect(page.locator("#sync-status")).toHaveText("✓ Saved", { timeout: 15000 });

  // The client never had `location`, so it cannot have sent it ...
  const writes = backend.posts.filter((p) => ["applyOps", "upsertRow"].includes(p.action));
  expect(writes.length).toBeGreaterThan(0);
  const sentRows = writes.flatMap((p) => p.ops ? p.ops.map((o) => o.row) : [p.row]).filter(Boolean);
  expect(sentRows.some((r) => "location" in r)).toBe(false);

  // ... and every stored row must still have it.
  expect(backend.rows("Roster").filter((r) => r.location === "Tekong").length).toBe(before);
  // The edit itself still landed.
  expect(backend.rows("Roster").some((r) => r.outOfCamp === true || r.outOfCamp === "TRUE")).toBe(true);
});

test("a stale full-tab write is rejected, not applied, and offers 'Push mine anyway'", async ({ page }) => {
  // `write` is the ONLY optimistic-concurrency-enforced action. A bulk replace
  // built against a stale baseRev must lose, and must lose LOUDLY - the user's
  // work is held on the device rather than silently dropped or clobbered.
  const backend = await bootAuthed(page, { seed: { Leave: [{ id: "L1", d4: "1401", type: "Annual Leave" }] } });
  // pushTab() calls confirmStaleness(), which raises confirm() when the server
  // has rows we have not pulled. Playwright auto-dismisses dialogs, so without
  // this the push is cancelled and never reaches the backend at all.
  page.on("dialog", (d) => d.accept());

  // Wait for launch sync to give the client a rev baseline.
  await expect.poll(() => page.evaluate(() => STATE.rev && STATE.rev.Leave)).toBeTruthy();

  // Another device writes Leave, so our baseRev goes stale.
  backend.bumpFromElsewhere("Leave", (rows) => rows.push({ id: "L2", d4: "1402", type: "Off" }));
  const serverRevAfter = backend.rev("Leave");

  // Now push a full replace built from the client's stale view.
  await page.evaluate(() => pushTab("Leave", STATE.leave));

  // The banner names the tab and offers the explicit re-push.
  const banner = page.locator("#sync-banner");
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText("Leave");
  await expect(banner).toContainText("NOT saved");
  await expect(banner.locator("button", { hasText: "Push mine anyway" })).toBeVisible();

  // The other device's row survived - the stale write did not clobber it.
  expect(backend.rows("Leave").some((r) => r.id === "L2")).toBe(true);
  expect(backend.rev("Leave")).toBe(serverRevAfter);
});

test("'Push mine anyway' re-pushes against the refreshed revision and succeeds", async ({ page }) => {
  const backend = await bootAuthed(page, { seed: { Leave: [{ id: "L1", d4: "1401", type: "Annual Leave" }] } });
  page.on("dialog", (d) => d.accept());
  await expect.poll(() => page.evaluate(() => STATE.rev && STATE.rev.Leave)).toBeTruthy();

  backend.bumpFromElsewhere("Leave", (rows) => rows.push({ id: "L2", d4: "1402", type: "Off" }));
  await page.evaluate(() => pushTab("Leave", STATE.leave));

  const banner = page.locator("#sync-banner");
  await expect(banner).toBeVisible({ timeout: 15000 });
  const revBefore = backend.rev("Leave");

  await banner.locator("button", { hasText: "Push mine anyway" }).click();

  // The re-push now carries a fresh baseRev, so it is accepted.
  await expect.poll(() => backend.rev("Leave"), { timeout: 15000 }).toBeGreaterThan(revBefore);
  const lastWrite = [...backend.posts].reverse().find((p) => p.action === "write");
  expect(lastWrite.tab).toBe("Leave");
  expect(Number(lastWrite.baseRev)).toBe(revBefore);
});

test("append is idempotent on id — a replayed append creates no duplicate", async ({ page }) => {
  // Matters because the client retries on transport failure with no
  // idempotency key of its own (js/sync.js dispatchWithNetRetry): dedup rests
  // entirely on the server matching row.id (apps-script-Code.gs:1005-1008).
  const backend = await bootAuthed(page);
  await expect.poll(() => backend.requests.length).toBeGreaterThan(0);

  const row = { id: "DUP1", d4: "1401", type: "Annual Leave", startDate: "01 Jul 2026" };
  const send = () => page.evaluate((r) =>
    API.post({ action: "append", tab: "Leave", row: r, baseRev: STATE.rev.Leave }), row);

  const first = await send();
  const second = await send();

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(second.action).toBe("noop");
  expect(backend.rows("Leave").filter((r) => r.id === "DUP1").length).toBe(1);
});

test("another device's change is noticed by revCheck and pulled tab-by-tab", async ({ page }) => {
  // The 20s poll must fetch ONLY what changed - never a full readAll, which is
  // what made the Apps Script backend feel slow.
  const backend = await bootAuthed(page, { seed: { Leave: [{ id: "L1", d4: "1401", type: "Annual Leave" }] } });
  await expect.poll(() => page.evaluate(() => STATE.rev && STATE.rev.Leave)).toBeTruthy();

  backend.bumpFromElsewhere("Leave", (rows) => rows.push({ id: "L9", d4: "1403", type: "Off" }));

  const readAllsBefore = backend.gets.filter((g) => g.action === "readAll").length;
  await page.evaluate(() => autoRefreshTick());

  // The new row reaches STATE ...
  await expect
    .poll(() => page.evaluate(() => STATE.leave.filter((l) => l.id === "L9").length), { timeout: 15000 })
    .toBe(1);
  // ... via a single-tab read, not a full re-download.
  expect(backend.gets.some((g) => g.action === "read" && g.tab === "Leave")).toBe(true);
  expect(backend.gets.filter((g) => g.action === "readAll").length).toBe(readAllsBefore);
});

test("an edit made offline is held, then drains on reconnect", async ({ page }) => {
  // Directly exercises the 'poor connectivity' case the unit actually hits.
  // The write must never be lost: it parks as dirty while the network is down
  // and lands by itself once the `online` event fires (js/sync.js:1030).
  const backend = await bootAuthed(page, { seed: { Roster: rosterSeed() } });
  page.on("dialog", (d) => d.accept());
  await expect.poll(() => page.evaluate(() => STATE.rev && STATE.rev.Roster)).toBeTruthy();

  const writesBefore = backend.posts.filter((p) => ["applyOps", "upsertRow"].includes(p.action)).length;

  backend.setOffline(true);
  await bookOutOnePerson(page, "Outfield");

  // The edit is applied locally and marked unsaved rather than silently dropped.
  await expect.poll(() => page.evaluate(() => (STATE.dirty && STATE.dirty.size) || 0),
    { timeout: 15000 }).toBeGreaterThan(0);
  expect(backend.posts.filter((p) => ["applyOps", "upsertRow"].includes(p.action)).length)
    .toBe(writesBefore);

  // Network returns.
  backend.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  // It drains on its own — no user tap, no lost edit.
  await expect(page.locator("#sync-status")).toHaveText("✓ Saved", { timeout: 20000 });
  expect(await page.evaluate(() => (STATE.dirty && STATE.dirty.size) || 0)).toBe(0);
  expect(backend.rows("Roster").some((r) => r.outOfCamp === true || r.outOfCamp === "TRUE")).toBe(true);
});
