const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

// These specs, unlike the rest of the suite, run the app AUTHENTICATED and with
// the Apps Script backend SCRIPTED via page.route - so we can drive the real
// sync engine (batching, 503 self-heal, 401 sign-in) end to end without a real
// server. GETs (revCheck/read/readAll/ping) get minimal valid bodies so the
// launch auto-sync and 20s poll never wedge; POST writes are what we assert on.

// Install the routed backend BEFORE navigation. Returns { posts } capturing
// every write POST body in order. `onPost(body)` may return a response object
// to override the per-action default (used to inject 503 / 401); return
// undefined to use the default success.
async function scriptBackend(page, onPost) {
  const posts = [];
  const build = "e2e-test";
  await page.route("**/script.google.com/**", async route => {
    const req = route.request();
    const fulfill = obj => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(Object.assign({ build }, obj))
    });
    if (req.method() === "GET") {
      const action = new URL(req.url()).searchParams.get("action") || "";
      if (action === "read") return fulfill({ rows: [], rev: 1 });
      return fulfill({ ok: true, revs: {} });   // revCheck / readAll / ping
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch { /* keep {} */ }
    posts.push(body);
    let resp = onPost ? onPost(body, posts.length) : undefined;
    if (!resp) {
      resp = body.action === "applyOps"
        ? { ok: true, tab: body.tab, applied: (body.ops || []).length, failed: 0, results: (body.ops || []).map(() => ({ ok: true })), rev: 2 }
        : { ok: true, rev: 2 };
    }
    return fulfill(resp);
  });
  return posts;
}

// Auth + backend must be in place before the app boots.
async function bootAuthed(page, onPost) {
  const posts = await scriptBackend(page, onPost);
  await page.addInitScript(() => localStorage.setItem("cougar-auth", "e2e-token"));
  await seedAndGoto(page);
  return posts;
}

const writePosts = posts => posts.filter(p =>
  ["applyOps", "upsertRow", "append", "appendMany", "deleteRowById", "write"].includes(p.action));

test("bulk group book-out sends ONE batched applyOps request, not one per recruit", async ({ page }) => {
  const posts = await bootAuthed(page);
  const errors = [];
  page.on("pageerror", e => errors.push(e));
  page.on("dialog", d => d.accept());

  // How many recruits a whole-platoon book-out should touch (derived, so the
  // assertion can't drift from the seed). Must be >1 for the batch to matter.
  const expected = await page.evaluate(() => bookOutTargets("plt:1").length);
  expect(expected).toBeGreaterThan(1);

  await page.click(`.nav-btn[data-nav="dashboard"]`);
  await page.click("text=+ Book Out");
  await page.selectOption("#f-bo-scope", "plt:1");
  await page.fill("#f-bo-reason", "Outfield");
  await page.click("#f-bo-submit");

  // The whole fan-out must arrive as exactly ONE applyOps request.
  await expect.poll(() => posts.filter(p => p.action === "applyOps").length).toBe(1);
  const batch = posts.find(p => p.action === "applyOps");
  expect(batch.tab).toBe("Roster");
  expect(batch.ops.length).toBe(expected);
  expect(batch.ops.every(o => o.op === "upsert")).toBe(true);
  // Crucially: NO per-recruit upsertRow requests (the old slow path).
  expect(posts.filter(p => p.action === "upsertRow").length).toBe(0);

  await expect(page.locator("#sync-status")).toHaveText("✓ Saved");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/sync-retry-batch.png", fullPage: true });
});

test("a 503 (server busy) self-heals: retries in place, ends Saved, zero user taps", async ({ page }) => {
  // Fail the first two write attempts with the server-busy body, then succeed.
  let writeAttempts = 0;
  const posts = await bootAuthed(page, body => {
    if (body.action === "applyOps" || body.action === "upsertRow") {
      writeAttempts++;
      if (writeAttempts <= 2) return { error: "Server busy, please retry", code: 503 };
    }
    return undefined;   // default success on the 3rd attempt
  });
  const errors = [];
  page.on("pageerror", e => errors.push(e));
  page.on("dialog", d => d.accept());

  // A single-person book-out → one write, exercising the in-place busy retry.
  await page.click(`.nav-btn[data-nav="dashboard"]`);
  await page.click("text=+ Book Out");
  await page.selectOption("#f-bo-scope", "person");
  await page.selectOption("#f-bo-d4", { index: 1 });
  await page.fill("#f-bo-reason", "MO");
  await page.click("#f-bo-submit");

  // It recovers to Saved on its own (never lands in the dirty/"unsaved" state),
  // after more than one attempt on the wire.
  await expect(page.locator("#sync-status")).toHaveText("✓ Saved", { timeout: 15000 });
  expect(writeAttempts).toBeGreaterThan(1);
  const dirty = await page.evaluate(() => (STATE.dirty && STATE.dirty.size) || 0);
  expect(dirty).toBe(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/sync-retry-503.png", fullPage: true });
});

test("a 401 (access revoked) shows 'Sign in again' and stops retrying", async ({ page }) => {
  // Every write is rejected as unauthorized.
  const posts = await bootAuthed(page, body =>
    writePostAction(body) ? { error: "Unauthorized — invite required", code: 401 } : undefined);
  const errors = [];
  page.on("pageerror", e => errors.push(e));
  page.on("dialog", d => d.accept());

  await page.click(`.nav-btn[data-nav="dashboard"]`);
  await page.click("text=+ Book Out");
  await page.selectOption("#f-bo-scope", "person");
  await page.selectOption("#f-bo-d4", { index: 1 });
  await page.fill("#f-bo-reason", "MO");
  await page.click("#f-bo-submit");

  // Loud, unmissable sign-in cue - not a generic "retry".
  await expect(page.locator("#sync-status")).toHaveText("⚠ Sign in again", { timeout: 10000 });

  // And it must NOT hammer the server: exactly one failed write, no retry loop.
  const after = writePosts(posts).length;
  await page.waitForTimeout(3000);
  expect(writePosts(posts).length).toBe(after);

  // Tapping the pill lands on the Sync tab (where the revoked-access card lives).
  await page.click("#sync-status");
  await expect.poll(() => page.evaluate(() => STATE.nav)).toBe("sync");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/sync-retry-401.png", fullPage: true });
});

function writePostAction(body) {
  return body && ["applyOps", "upsertRow", "append", "appendMany", "deleteRowById", "write"].includes(body.action);
}
