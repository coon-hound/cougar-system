// Shared e2e support: seed the app's localStorage from the demo fixture BEFORE
// any page script runs, then navigate. Because STATE.authToken stays empty, the
// app boots straight from this cache with zero network (see js/main.js). Every
// spec goes through seedAndGoto so real-browser runs are deterministic and
// offline — the browser analogue of the node harness's mock fetch.
const path = require("path");
const fs = require("fs");
const rawSeed = require("./fixtures/demo-seed.json");

// The data cache key is VERSIONED, and it gets bumped at every change of intake
// to force stale phones to drop the cohort that went home
// (docs/INTAKE-MIGRATION.md). Read it out of the app rather than hardcoding it
// here: a fixture seeding "cougar-data-v2" against an app reading
// "cougar-data-v3" boots an empty roster, and the whole suite fails with
// timeouts that say nothing about the actual cause. It has cost one bump
// already.
const DATA_KEY = (() => {
  const src = fs.readFileSync(path.join(__dirname, "../../js/state.js"), "utf8");
  const m = src.match(/const STORAGE_KEY\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("could not read STORAGE_KEY out of js/state.js");
  return m[1];
})();

// Re-key whatever data cache the fixture carries onto the version the app is
// actually reading, so bumping STORAGE_KEY never needs a fixture edit.
const seed = Object.fromEntries(
  Object.entries(rawSeed).map(([k, v]) => [/^cougar-data(-v\d+)?$/.test(k) ? DATA_KEY : k, v]),
);

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

module.exports = { seedAndGoto, SEED, DATA_KEY };
