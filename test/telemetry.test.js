// Unit tests for the usage-telemetry collector (js/telemetry.js).
//
// Four things are worth holding here, and the first is not negotiable:
//
//  (a) PRIVACY. This app holds medical records for real soldiers. A 4D, a
//      name, a medical tag or a free-text reason must not be able to reach the
//      event buffer by ANY path, and the raw device token — a live credential —
//      must never be what identifies a device.
//  (b) The buffer stays bounded: capped, pruned oldest-first, counters kept
//      alongside so the read-out survives the prune.
//  (c) The click-cost arithmetic, because it is what the product decision is
//      made from. Averaging over STARTED rather than ENDED sessions understates
//      every cost, and nobody would notice from the screen.
//  (d) Monkey-patching is perfectly transparent. A telemetry wrapper sits in
//      front of submitBookOut; if it alters `this`, an argument, a return value
//      or an exception, telemetry has changed what the app does.
//
// It also compiles telemetry.js + render-usage.js INTO the shared global bundle
// (static.test.js only sees scripts already referenced by index.html, and these
// two are not wired yet), so the duplicate-top-level-declaration failure that
// blanks the whole dashboard is caught before wiring rather than after.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { suite, test, ok, eq, throws } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const T = require(path.join(ROOT, "js/telemetry.js"));

// Minimal stand-in for a DOM element. descriptorFor only ever uses
// getAttribute / tagName / className / parentElement — deliberately never
// `.value` and, since the hardening below, never `.textContent` either.
function el(opts) {
  const attrs = opts.attrs || {};
  return {
    tagName: opts.tag || "DIV",
    className: opts.cls || "",
    textContent: opts.text || "",
    parentElement: opts.parent || null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null)
  };
}

module.exports = async function run() {
  suite("telemetry: privacy — no personal data can reach the buffer");

  await test("an onclick argument is never recorded, only the function name", () => {
    const btn = el({ tag: "BUTTON", cls: "btn", attrs: { onclick: "openPerson('1101')" } });
    eq(T.descriptorFor(btn), "openPerson");
    const nested = el({ tag: "SPAN", parent: el({ tag: "BUTTON", attrs: { onclick: "openMedicalForm('1404','1101')" } }) });
    eq(T.descriptorFor(nested), "openMedicalForm");
  });

  await test("a 4D in element text cannot become a descriptor", () => {
    // A roster row button with no handler attribute: the fallback is built from
    // markup alone (tag/class/id) and never reads the text, so neither the 4D
    // nor the NAME beside it has a path into the record.
    const btn = el({ tag: "BUTTON", cls: "btn btn-primary", text: "1101 TAN WEI MING", attrs: { id: "row-open" } });
    const d = T.descriptorFor(btn);
    ok(!/\d/.test(d), "descriptor carries no digits: " + d);
    ok(!/TAN|WEI|MING/i.test(d), "descriptor carries no name: " + d);
    eq(d, "button.btn#row-open");
  });

  await test("scrubName deletes 4Ds, dates and phone numbers", () => {
    eq(T.scrubName("1101"), "");
    eq(T.scrubName("openBookOutForm"), "openBookOutForm");
    eq(T.scrubName("MC until 2026-05-27"), "MC until --");
    eq(T.scrubName("Excuse RMJ 91234567"), "Excuse RMJ");
  });

  await test("the name gate is an allow-list, so prose is refused not cleaned", () => {
    // Stripping digits defeats a 4D but not a NAME. Every legitimate descriptor
    // is a single token; anything with whitespace is not a descriptor.
    ok(T.isSafeName("submitBookOut"));
    ok(T.isSafeName("nav:roster"));
    ok(T.isSafeName("role:Commander"));
    ok(T.isSafeName("button.btn#pull-btn"));
    ok(T.isSafeName("book_out"));
    ok(!T.isSafeName("TAN WEI MING"), "a name is refused");
    ok(!T.isSafeName("Excuse RMJ ankle sprain"), "a free-text reason is refused");
    ok(!T.isSafeName(""), "an empty name is refused");
  });

  await test("nothing resembling a 4D survives into the stored buffer", () => {
    T.clearLocal();
    // Every hostile shape at once: a 4D argument, a 4D as a descriptor, a name,
    // and a free-text medical reason.
    T._record({ k: "click", n: "openPerson" });
    T._record({ k: "click", n: "1101" });
    T._record({ k: "click", n: "1101 TAN WEI MING — Excuse RMJ, ankle sprain" });
    T._record({ k: "view", n: "roster", ms: 4200 });
    // Every string the store can hold that is not a timestamp, a counter or the
    // ISO day key: the raw event names and every counter key.
    const days = T.localDays();
    const names = T._buffer().map(e => e.n);
    for (const d of Object.values(days)) {
      names.push(...Object.keys(d.features), ...Object.keys(d.views), ...Object.keys(d.tasks));
    }
    ok(names.every(n => !/\d/.test(n)), "no recorded name carries a digit: " + JSON.stringify(names));
    ok(names.every(n => T.isSafeName(n)), "every recorded name passes the allow-list: " + JSON.stringify(names));
    const dumped = JSON.stringify({ buf: T._buffer(), pending: T._pending(), days });
    ok(!/TAN|WEI MING|ankle|sprain|RMJ/i.test(dumped), "no name or reason text: " + dumped);
    // The bare "1101" scrubbed to nothing and the prose failed the allow-list;
    // both were dropped rather than stored in a cleaned-up form. Only the two
    // legitimate descriptors survive.
    eq(T._buffer().map(e => e.n), ["openPerson", "roster"]);
  });

  await test("the device id is a hash, never the live auth token", () => {
    const token = "7b1f0c2e-3d4a-4f55-9c8b-112233445566";
    const id = T.deviceIdFrom(token);
    ok(!token.includes(id), "id is not a substring of the token");
    ok(/^[0-9a-f]{8}$/.test(id), "id is 8 hex chars: " + id);
    eq(T.deviceIdFrom(token), id, "stable across calls");
    ok(T.deviceIdFrom(token) !== T.deviceIdFrom(token + "x"), "different tokens differ");
    eq(T.deviceIdFrom(""), "", "no token, no id");
  });

  suite("telemetry: buffer and counters stay bounded");

  await test("the buffer prunes oldest-first", () => {
    const buf = Array.from({ length: 10 }, (_, i) => ({ n: i }));
    eq(T.pruneBuffer(buf, 4).map(e => e.n), [6, 7, 8, 9]);
    eq(T.pruneBuffer(buf, 20).length, 10, "under cap is untouched");
  });

  await test("counters keep the newest days and drop the rest", () => {
    const days = { "2026-09-10": 1, "2026-09-11": 2, "2026-09-12": 3, "2026-09-13": 4 };
    eq(Object.keys(T.pruneDays(days, 2)), ["2026-09-12", "2026-09-13"]);
  });

  await test("a pruned buffer does not lose the counters", () => {
    T.clearLocal();
    for (let i = 0; i < T.BUF_CAP + 50; i++) T._record({ k: "click", n: "openBookOutForm" });
    ok(T._buffer().length <= T.BUF_CAP, "buffer capped at " + T.BUF_CAP);
    const total = Object.values(T.localDays())
      .reduce((s, d) => s + (d.features.openBookOutForm || 0), 0);
    eq(total, T.BUF_CAP + 50, "every click still counted, raw events or not");
  });

  suite("telemetry: aggregation and click cost");

  await test("aggregate folds clicks, dwell and task outcomes", () => {
    const m = {};
    T.aggregate(m, { k: "click", n: "submitBookOut", day: "2026-09-15" });
    T.aggregate(m, { k: "click", n: "submitBookOut", day: "2026-09-15" });
    T.aggregate(m, { k: "view", n: "roster", ms: 3000, day: "2026-09-15" });
    T.aggregate(m, { k: "view", n: "roster", ms: 1000, day: "2026-09-15" });
    T.aggregate(m, { k: "task_start", n: "book_out", day: "2026-09-15" });
    T.aggregate(m, { k: "task_end", n: "book_out", o: "completed", c: 6, ms: 20000, day: "2026-09-15" });
    const d = m["2026-09-15"];
    eq(d.features.submitBookOut, 2);
    eq(d.views.roster, { n: 2, ms: 4000 });
    eq(d.tasks.book_out, { starts: 1, done: 1, aban: 0, clicks: 6, ms: 20000 });
  });

  await test("clicks-per-task averages over ENDED sessions, not started", () => {
    // 5 started, 4 finished (3 done + 1 abandoned), 24 taps across those 4.
    // The 5th is still open and contributed no taps; dividing by 5 would say
    // 4.8 taps and understate the real cost of 6.
    const c = T.clickCost("book_out", { starts: 5, done: 3, aban: 1, clicks: 24, ms: 80000 });
    eq(c.ended, 4);
    eq(c.avgClicks, 6);
    eq(c.abandonRate, 25);
    eq(c.cost, 24, "total taps is what the task cost the company");
    eq(c.avgMs, 20000);
    eq(c.label, "Book Out", "label comes from the task registry");
  });

  await test("a task nobody has finished reports zero, not NaN", () => {
    const c = T.clickCost("log_leave", { starts: 2, done: 0, aban: 0, clicks: 0, ms: 0 });
    eq(c.avgClicks, 0);
    eq(c.abandonRate, 0);
  });

  await test("summarize ranks tasks by total taps spent", () => {
    const days = {
      "2026-09-15": {
        features: { submitBookOut: 9, openPerson: 30 },
        views: { roster: { n: 5, ms: 50000 }, dashboard: { n: 9, ms: 30000 } },
        tasks: {
          book_out: { starts: 10, done: 8, aban: 2, clicks: 60, ms: 200000 },
          soc_entry: { starts: 1, done: 1, aban: 0, clicks: 9, ms: 9000 }
        }
      }
    };
    const s = T.summarize(days, { days: 3650 });
    eq(s.features[0].name, "openPerson", "most-tapped action first");
    eq(s.views[0].name, "dashboard", "most-opened view first");
    eq(s.tasks[0].key, "book_out", "expensive-in-aggregate beats expensive-per-use");
    eq(s.views[0].avgMs, 3333);
  });

  await test("the recommendation says what to do, in words", () => {
    const days = {
      "2026-09-15": {
        features: {}, views: {},
        tasks: {
          book_out:  { starts: 47, done: 45, aban: 2, clicks: 282, ms: 900000 },
          soc_entry: { starts: 1, done: 1, aban: 0, clicks: 3, ms: 4000 },
          log_leave: { starts: 12, done: 4, aban: 8, clicks: 60, ms: 200000 }
        }
      }
    };
    const recs = T.recommend(T.summarize(days, { days: 3650 }));
    const promote = recs.find(r => r.key === "book_out");
    ok(promote, "book_out is recommended");
    eq(promote.verdict, "promote");
    ok(/used 47x/.test(promote.why), "states the frequency: " + promote.why);
    ok(/6 taps/.test(promote.why), "states the tap cost: " + promote.why);
    const leaky = recs.find(r => r.key === "log_leave");
    ok(leaky && leaky.verdict === "investigate", "a two-thirds abandonment rate is flagged");
    ok(/67% of 12 attempts/.test(leaky.why), "states the leak in words: " + leaky.why);
    eq(recs[0].key, "log_leave", "a broken funnel outranks a promotion candidate");
    ok(!recs.some(r => r.key === "soc_entry"), "a once-used task is not a finding");
  });

  await test("no data yields no recommendation rather than a made-up one", () => {
    eq(T.recommend({ tasks: [] }), []);
    eq(T.recommend(T.summarize({}, { days: 14 })), []);
  });

  suite("telemetry: flush payload");

  await test("rowsFrom flattens the pending delta into counter rows", () => {
    const rows = T.rowsFrom({
      "2026-09-15": {
        features: { submitBookOut: 3 },
        views: { roster: { n: 2, ms: 8000 } },
        tasks: { book_out: { starts: 2, done: 1, aban: 1, clicks: 11, ms: 30000 } }
      }
    });
    eq(rows.length, 3);
    eq(rows.find(r => r.kind === "feature"),
       { day: "2026-09-15", kind: "feature", name: "submitBookOut", events: 3, completed: 0, abandoned: 0, clicks: 0, ms: 0 });
    eq(rows.find(r => r.kind === "view"),
       { day: "2026-09-15", kind: "view", name: "roster", events: 2, completed: 0, abandoned: 0, clicks: 0, ms: 8000 });
    eq(rows.find(r => r.kind === "task"),
       { day: "2026-09-15", kind: "task", name: "book_out", events: 2, completed: 1, abandoned: 1, clicks: 11, ms: 30000 });
    // Every field is a day, a vocabulary word or an integer. There is nowhere
    // for personal data to ride along even if the client scrub failed.
    ok(rows.every(r => /^[\w:. /-]+$/.test(r.name)), "names stay identifier-shaped");
  });

  suite("telemetry: monkey-patching is transparent");

  await test("the wrapper preserves this, arguments and the return value", () => {
    const calls = [];
    const scope = { x: 10, f(a, b) { calls.push([this.x, a, b]); return a + b + this.x; } };
    ok(T._wrapGlobal(scope, "f", () => calls.push("before"), (okFlag) => calls.push(["after", okFlag])));
    eq(scope.f(1, 2), 13);
    eq(calls, ["before", [10, 1, 2], ["after", true]]);
  });

  await test("an exception propagates unchanged and is still recorded as a failure", () => {
    const seen = [];
    const scope = { boom() { throw new RangeError("nope"); } };
    T._wrapGlobal(scope, "boom", null, (okFlag) => seen.push(okFlag));
    let caught = null;
    try { scope.boom(); } catch (e) { caught = e; }
    ok(caught instanceof RangeError && caught.message === "nope", "the original error reaches the caller");
    eq(seen, [false]);
  });

  await test("an async submit returns its own promise and is observed, not replaced", async () => {
    const seen = [];
    const scope = { async save() { return "saved"; } };
    T._wrapGlobal(scope, "save", null, (okFlag) => seen.push(okFlag));
    const p = scope.save();
    ok(typeof p.then === "function", "still a promise");
    eq(await p, "saved");
    await Promise.resolve();
    eq(seen, [true]);
  });

  await test("a rejected async submit still rejects, and counts as abandoned", async () => {
    const seen = [];
    const scope = { async save() { throw new Error("offline"); } };
    T._wrapGlobal(scope, "save", null, (okFlag) => seen.push(okFlag));
    let caught = null;
    await scope.save().catch(e => { caught = e; });
    eq(caught.message, "offline");
    await Promise.resolve();
    eq(seen, [false]);
  });

  await test("a missing global is skipped, never thrown on", () => {
    const scope = {};
    eq(T._wrapGlobal(scope, "functionThatWasRenamedLastMonth", null, null), false);
    eq(scope.functionThatWasRenamedLastMonth, undefined, "nothing invented in its place");
  });

  await test("double-wrapping is a no-op, so a re-install cannot double-count", () => {
    let n = 0;
    const scope = { f() {} };
    T._wrapGlobal(scope, "f", () => n++, null);
    T._wrapGlobal(scope, "f", () => n++, null);
    scope.f();
    eq(n, 1);
  });

  suite("telemetry: the task registry matches the app as it stands");

  await test("every registered global actually exists in js/forms.js or js/render.js", () => {
    const src = ["js/forms.js", "js/render.js", "js/helpers.js", "js/sync.js"]
      .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
    const missing = [];
    for (const key of Object.keys(T.TASKS)) {
      for (const name of [T.TASKS[key].start, T.TASKS[key].done]) {
        if (!name) continue;
        if (!new RegExp("function\\s+" + name + "\\s*\\(").test(src)) missing.push(key + "." + name);
      }
    }
    // Drift is survivable at runtime (skipped with one warning) but it means
    // the funnel silently stops being measured, so it is worth a red test.
    ok(missing.length === 0, "registry names with no matching function: " + JSON.stringify(missing));
  });

  suite("telemetry: load-time safety for the un-wired scripts");

  await test("telemetry.js + render-usage.js parse into the shared global scope", () => {
    // static.test.js only compiles the scripts index.html already references.
    // These two are not wired yet, so this is the guard until they are: a
    // duplicate top-level const/let across js/*.js blanks the whole dashboard.
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const wired = [...html.matchAll(/<script\s+src="(js\/[^"?]+)/g)].map(m => m[1]);
    const files = [...wired];
    for (const f of ["js/render-usage.js", "js/telemetry.js"]) if (!files.includes(f)) files.push(f);
    const bundle = files.map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");
    new vm.Script(bundle, { filename: "bundle+telemetry.js" });   // throws on a duplicate declaration
  });

  await test("the usage table is kept out of the sync cycle", () => {
    // The single most important architectural constraint in this feature: an
    // append-only usage stream inside REV_TABS would make every recorded click
    // wake every other phone in the company for a pull (TELEMETRY-DESIGN.md).
    const edge = fs.readFileSync(path.join(ROOT, "supabase/functions/api/index.ts"), "utf8");
    const mig = fs.readFileSync(path.join(ROOT, "supabase/migrations/0005_usage.sql"), "utf8");
    ok(!/STATE_KEY[\s\S]{0,600}[Uu]sage/.test(edge), "usage is not in STATE_KEY (and so not in REV_TABS/readAll)");
    ok(!/insert into revs[\s\S]{0,200}[Uu]sage/i.test(mig), "usage is not seeded into revs");
    ok(/usageAppend/.test(edge) && /usageRead/.test(edge), "the dedicated actions exist");
    // Both usage actions must be dispatched before the tab lookup, and neither
    // may be routed through withRev.
    const appendFn = edge.slice(edge.indexOf("async function usageAppend"), edge.indexOf("async function usageRead"));
    ok(!/withRev\(/.test(appendFn), "usageAppend never bumps a revision");
  });

  await test("js/api.js reaches the server directly, without the sync machinery", () => {
    const api = fs.readFileSync(path.join(ROOT, "js/api.js"), "utf8");
    const seg = api.slice(api.indexOf("usageAppend"));
    ok(!/baseRev/.test(seg), "no baseRev — usage carries no optimistic-concurrency contract");
    ok(!/markDirty|STATE\.dirty/.test(api), "api.js never marks a tab dirty");
    ok(/sendBeacon/.test(api), "the page-hide flush uses sendBeacon");
  });
};
