// Shared e2e support: seed the app's localStorage from the demo fixture BEFORE
// any page script runs, then navigate. Because STATE.authToken stays empty, the
// app boots straight from this cache with zero network (see js/main.js). Every
// spec goes through seedAndGoto so real-browser runs are deterministic and
// offline — the browser analogue of the node harness's mock fetch.
const path = require("path");
const seed = require("./fixtures/demo-seed.json");

// The fixture is a map of localStorage-key -> value. Values are stored as JSON
// strings (that's how the app persists them via JSON.stringify).
async function seedAndGoto(page, url = "/index.html") {
  const entries = Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]);
  await page.addInitScript((pairs) => {
    for (const [k, v] of pairs) localStorage.setItem(k, v);
  }, entries);
  await page.goto(url);
  // The bootstrap runs loadLocal() + render() synchronously on DOMContentLoaded;
  // wait for STATE to be populated so assertions don't race the first paint.
  await page.waitForFunction(() => typeof STATE !== "undefined" && Array.isArray(STATE.roster));
  // Dismiss any launch modal so its full-screen overlay can't intercept clicks.
  // The seed also pre-stamps "cougar-seen-version" to suppress the "What's New"
  // patch-notes popup, but this keeps specs robust against any future launch modal.
  await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
}

// Convenience: number of recruits/commanders the fixture seeds.
const SEED = seed;

module.exports = { seedAndGoto, SEED };
