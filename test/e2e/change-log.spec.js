// The Change Log tab: who added, edited or deleted what.
//
// Like the Access tab, this pins the client half only: hidden unless the
// backend says can_invite, and how auditLog's entries are drawn. The refusal
// itself is server-side and is verified against a running backend
// (test/live/api-contract.test.js).
//
// The entries below are the shape auditLog returned from the real Edge
// Function for an appendMany of two Medical rows by one token, then an
// applyOps edit + delete by another.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

function entries(d4) {
  const upload = "2026-10-20T08:00:00.000Z";
  const fix = "2026-10-20T09:30:00.000Z";
  return [
    { id: "308", at: fix, person: "DEV ADMIN", device: "laptop", action: "applyOps:delete",
      tab: "Medical", row_id: "T2", ok: true, detail: {}, kind: "deleted", d4, name: null,
      changes: null, record: { id: "T2", d4, status: "LD", reason: "knee" } },
    { id: "307", at: fix, person: "DEV ADMIN", device: "laptop", action: "applyOps:upsert",
      tab: "Medical", row_id: "T1", ok: true, detail: {}, kind: "edited", d4, name: null,
      changes: [{ field: "reason", from: "fever", to: "fever 38.5" }], record: null },
    { id: "305", at: upload, person: "SGT DEMO", device: "phone", action: "appendMany:append",
      tab: "Medical", row_id: "T2", ok: true, detail: {}, kind: "added", d4, name: null,
      changes: null, record: { id: "T2", d4, status: "LD", reason: "knee" } },
    { id: "304", at: upload, person: "SGT DEMO", device: "phone", action: "appendMany:append",
      tab: "Medical", row_id: "T1", ok: true, detail: {}, kind: "added", d4, name: null,
      changes: null, record: { id: "T1", d4, status: "MC", reason: "fever" } },
    { id: "303", at: upload, person: "DEV ADMIN", device: "laptop", action: "write",
      tab: "MSK", row_id: "", ok: true, detail: { rows: 12 }, kind: null, d4: null, name: null,
      changes: null, record: null },
  ];
}

async function openAsAdmin(page) {
  await seedAndGoto(page);
  const d4 = await page.evaluate(() => STATE.roster.find(r => r.id).id);
  await page.evaluate((list) => {
    window.__auditCalls = [];
    API.auditLog = async (opts) => { window.__auditCalls.push(opts); return { ok: true, entries: list, more: false }; };
    STATE.me = { person: "DEV ADMIN", canInvite: true };
    STATE.nav = "changelog"; render();
  }, entries(d4));
  return d4;
}

test.describe("Change Log tab", () => {
  test("is hidden until the backend says this device is the admin", async ({ page }) => {
    await seedAndGoto(page);
    const btn = page.locator('.nav-btn[data-nav="changelog"]');
    await expect(btn).toHaveCount(1);
    await expect(btn).toBeHidden();

    await page.evaluate(() => { API.whoami = async () => ({ ok: true, person: "A", canInvite: false }); });
    await page.evaluate(() => refreshIdentity());
    await expect(btn).toBeHidden();

    await page.evaluate(() => { API.whoami = async () => ({ ok: true, person: "A", canInvite: true }); });
    await page.evaluate(() => refreshIdentity());
    await expect(btn).toBeVisible();
  });

  test("shows nothing, and asks for nothing, without the capability", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      window.__asked = false;
      API.auditLog = async () => { window.__asked = true; return { ok: true, entries: [] }; };
      STATE.me = { person: "A Commander", canInvite: false };
      STATE.nav = "changelog"; render();
    });
    await expect(page.locator("#content")).toContainText("cannot view the change log");
    expect(await page.evaluate(() => window.__asked)).toBe(false);
  });

  test("folds one upload into one card naming who sent it", async ({ page }) => {
    const d4 = await openAsAdmin(page);
    const body = page.locator("#content");

    await expect(body).toContainText("Added 2 Medical records");
    await expect(body).toContainText("SGT DEMO");
    await expect(body).toContainText("phone");
    await expect(body).toContainText("Replaced the whole MSK tab (12 rows)");
    // The later edit + delete are one request too.
    await expect(body).toContainText("Edited 1, deleted 1 Medical records");

    // Expanding the upload shows what each row said, under the person's 4D.
    await body.locator("text=Added 2 Medical records").click();
    await expect(body).toContainText(d4);
    await expect(body).toContainText("fever");
    await expect(body).toContainText("knee");
  });

  test("an edit shows what the field said before and after", async ({ page }) => {
    await openAsAdmin(page);
    const body = page.locator("#content");
    await body.locator("text=Edited 1, deleted 1 Medical records").click();
    await expect(body).toContainText("reason");
    await expect(body).toContainText("fever 38.5");
    await expect(body.locator(".badge", { hasText: "deleted" })).toHaveCount(1);
  });

  test("narrows by person locally and by module on the server", async ({ page }) => {
    await openAsAdmin(page);
    const body = page.locator("#content");

    await page.selectOption('select[aria-label="Who"]', "SGT DEMO");
    await expect(body).toContainText("Added 2 Medical records");
    await expect(body).not.toContainText("Replaced the whole MSK tab");

    await page.selectOption('select[aria-label="Module"]', "Medical");
    const last = await page.evaluate(() => window.__auditCalls[window.__auditCalls.length - 1]);
    expect(last.tab).toBe("Medical");
  });

  test("says so when the backend cannot answer", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      API.auditLog = async () => ({ error: "Invalid request" });
      STATE.me = { person: "DEV ADMIN", canInvite: true };
      STATE.nav = "changelog"; render();
    });
    await expect(page.locator("#content")).toContainText("Could not load the change log: Invalid request");
  });
});
