// The Access tab: only the owner's device may hand out access.
//
// What this CAN pin offline is the client half — that the tab is hidden until
// the backend says otherwise, and that the view refuses to render its controls
// without the capability.
//
// What it deliberately does NOT pin is the security itself. The control is
// server-side: the Edge Function refuses listAccess / createInvite /
// revokeAccess for any token without `can_invite`, and that is verified against
// a real running backend (test/live/api-contract.test.js), because a test that
// asserted the button was hidden would be asserting the wrong thing. js/* is
// public code; hiding a button protects nothing.
const { test, expect } = require("@playwright/test");
const { seedAndGoto } = require("./support");

test.describe("Access tab", () => {
  test("is hidden for a device the backend has not blessed", async ({ page }) => {
    await seedAndGoto(page);

    // The offline fixture has no token, so whoami is never asked and STATE.me
    // stays null — exactly the state of an ordinary commander's phone.
    const me = await page.evaluate(() => STATE.me);
    expect(me).toBeNull();

    const btn = page.locator('.nav-btn[data-nav="access"]');
    await expect(btn).toHaveCount(1);          // present in the markup…
    await expect(btn).toBeHidden();            // …and not shown
  });

  test("refuses to render its controls without the capability", async ({ page }) => {
    await seedAndGoto(page);

    // Force the view open the way someone reading the public source would.
    // It must show nothing actionable: no person picker, no create button.
    await page.evaluate(() => { STATE.me = { person: "A Commander", canInvite: false }; });
    await page.evaluate(() => { STATE.nav = "access"; render(); });

    await expect(page.locator("#content")).toContainText("cannot manage access");
    await expect(page.locator("#acc-who")).toHaveCount(0);
  });

  test("shows the person picker when the backend has said yes", async ({ page }) => {
    await seedAndGoto(page);

    await page.evaluate(() => { STATE.me = { person: "Aaron", canInvite: true }; });
    await page.evaluate(() => { STATE.nav = "access"; render(); });

    // Every person on the roster is offered, so a link is always tagged to
    // somebody real rather than typed in by hand.
    const options = page.locator("#acc-who option");
    const rosterSize = await page.evaluate(() => STATE.roster.filter(r => r.id).length);
    await expect(options).toHaveCount(rosterSize + 1);   // + the "Choose…" row

    await expect(page.locator("#content")).toContainText("Signed in as");
    await expect(page.locator("#content")).toContainText("Aaron");
  });

  test("the nav button is revealed only by the backend's answer", async ({ page }) => {
    await seedAndGoto(page);
    const btn = page.locator('.nav-btn[data-nav="access"]');
    await expect(btn).toBeHidden();

    // refreshIdentity is what unhides it, and only on canInvite.
    await page.evaluate(() => {
      window.API = window.API || {};
      API.whoami = async () => ({ ok: true, person: "Aaron", canInvite: true });
    });
    await page.evaluate(() => refreshIdentity());
    await expect(btn).toBeVisible();
  });
});
