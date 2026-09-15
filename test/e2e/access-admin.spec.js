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

  test("offers a device name, so one person can have several", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => { STATE.me = { person: "Aaron", canInvite: true }; });
    await page.evaluate(() => { STATE.nav = "access"; render(); });

    // Without a device name, two devices for one person are indistinguishable
    // in the list and a lost tablet cannot be revoked on its own.
    await expect(page.locator("#acc-device")).toHaveCount(1);
    await expect(page.locator("#acc-device")).toHaveValue("phone");
  });

  test("groups a person's devices together and offers Re-issue on each", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.me = { person: "Aaron", canInvite: true };
      // What listAccess returns for someone holding two devices plus an
      // unopened link. Faked because the offline suite has no backend; the
      // real shape is verified against a running one.
      _accessRows = [
        { kind: "token", person: "ARJUN TEO", d4: "0004", device_label: "phone",
          status: "active", last_seen_at: new Date().toISOString(), can_invite: false },
        { kind: "token", person: "ARJUN TEO", d4: "0004", device_label: "tablet",
          status: "active", last_seen_at: new Date().toISOString(), can_invite: false },
        { kind: "invite", person: "ARJUN TEO", d4: "0004", device_label: "laptop",
          status: "open", used_count: 0, max_uses: 3, token: "inv-1",
          expires_at: new Date(Date.now() + 8.64e7).toISOString(), can_invite: false },
      ];
      STATE.nav = "access"; render();
    });

    const body = page.locator("#content");
    // One heading for the person, not three.
    await expect(body.locator("text=ARJUN TEO")).toHaveCount(1);
    await expect(body).toContainText("phone");
    await expect(body).toContainText("tablet");
    await expect(body).toContainText("Re-issue");     // the cleared-browser fix
    await expect(body).toContainText("Copy link");    // open invites keep their link
    await expect(body).toContainText("not opened yet");
  });

  test("says a multi-use link is still usable once it has been opened", async ({ page }) => {
    await seedAndGoto(page);
    await page.evaluate(() => {
      STATE.me = { person: "Aaron", canInvite: true };
      // A 3-use link redeemed once is NOT "not opened yet" — it is a live
      // credential with uses left, and the page must not say otherwise.
      _accessRows = [{ kind: "invite", person: "ARJUN TEO", d4: "0004",
        device_label: "phone", status: "open", used_count: 1, max_uses: 3,
        token: "inv-2", expires_at: new Date(Date.now() + 8.64e7).toISOString() }];
      STATE.nav = "access"; render();
    });
    await expect(page.locator("#content")).toContainText("link still usable");
    await expect(page.locator("#content")).toContainText("2 uses left");
    await expect(page.locator("#content")).not.toContainText("not opened yet");
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
    // Nobody is disabled: a second device for someone who already has access is
    // a normal thing to want, and the old version blocked it.
    await expect(page.locator("#acc-who option[disabled]")).toHaveCount(0);

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
