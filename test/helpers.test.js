// Unit tests for the shared in/out-of-camp computation (js/helpers.js):
// outOfCampMap / isBookedOut — the single source of truth the dashboard strength
// board AND the parade state both read.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

// Load the REAL helpers.js with a provided STATE. helpers.js defines its own
// medStatusActive/displayDateToISO/todayISO, so no other files are needed.
function loadHelpers(state) {
  const sandbox = {
    STATE: state, console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js/helpers.js"), "utf8"), sandbox, { filename: "helpers.js" });
  return sandbox;
}

const DATE = "2026-06-25";
const YESTERDAY = "2026-06-24";
const baseState = () => ({
  roster: [
    { id: "1101", role: "Recruit" }, { id: "1102", role: "Recruit" },
    { id: "1103", role: "Recruit" }, { id: "1104", role: "Recruit" }
  ],
  medical: [],
  leave: []
});

module.exports = async function run() {
  suite("helpers: outOfCampMap / isBookedOut (shared in/out-of-camp)");

  await test("active MC counts as out of camp (kind=medical)", () => {
    const s = baseState();
    s.medical = [{ d4: "1101", status: "MC", startDate: "20 Jun 2026", endDate: "27 Jun 2026" }];
    const h = loadHelpers(s);
    const m = h.outOfCampMap(DATE);
    ok(m.has("1101"), "MC recruit is out");
    eq(m.get("1101").kind, "medical");
  });

  await test("consume-in-camp MC does NOT count as out of camp", () => {
    const s = baseState();
    s.medical = [
      { d4: "1101", status: "MC", startDate: "20 Jun 2026", endDate: "27 Jun 2026", inCamp: true },
      { d4: "1102", status: "MC", startDate: "20 Jun 2026", endDate: "27 Jun 2026", inCamp: false }
    ];
    const m = loadHelpers(s).outOfCampMap(DATE);
    ok(!m.has("1101"), "inCamp MC is counted present");
    ok(m.has("1102"), "normal MC still out of camp");
  });

  await test("LD does NOT count as out of camp (restricted but in camp)", () => {
    const s = baseState();
    s.medical = [{ d4: "1102", status: "LD", startDate: "20 Jun 2026", endDate: "27 Jun 2026" }];
    ok(!loadHelpers(s).outOfCampMap(DATE).has("1102"), "LD stays in camp");
  });

  await test("active leave counts as out of camp (kind=leave)", () => {
    const s = baseState();
    s.leave = [{ d4: "1103", type: "Annual Leave", startDate: "01 Jun 2026", endDate: "30 Jun 2026" }];
    eq(loadHelpers(s).outOfCampMap(DATE).get("1103").kind, "leave");
  });

  await test("booked out TODAY counts; YESTERDAY auto-clears", () => {
    const s = baseState();
    s.roster[0].outOfCamp = true; s.roster[0].outSince = DATE;        // today → out
    s.roster[1].outOfCamp = true; s.roster[1].outSince = YESTERDAY;   // stale → in
    const m = loadHelpers(s).outOfCampMap(DATE);
    eq(m.get("1101").kind, "bookedout");
    ok(!m.has("1102"), "yesterday's book-out auto-cleared (counted in camp)");
  });

  await test("medical takes precedence over a same-day book-out", () => {
    const s = baseState();
    s.medical = [{ d4: "1101", status: "Warded", startDate: "20 Jun 2026", endDate: "27 Jun 2026" }];
    s.roster[0].outOfCamp = true; s.roster[0].outSince = DATE;
    eq(loadHelpers(s).outOfCampMap(DATE).get("1101").kind, "medical");
  });

  await test("isBookedOut: day-scoped + boolean/text coercion", () => {
    const h = loadHelpers(baseState());
    ok(h.isBookedOut({ outOfCamp: true, outSince: DATE }, DATE), "boolean true today");
    ok(h.isBookedOut({ outOfCamp: "TRUE", outSince: DATE }, DATE), "text TRUE today");
    ok(!h.isBookedOut({ outOfCamp: true, outSince: YESTERDAY }, DATE), "stale day");
    ok(!h.isBookedOut({ outOfCamp: false, outSince: DATE }, DATE), "not booked");
  });

  suite("helpers: IPPT multi-attempt series (drives the cross-conduct charts)");

  // 1101 improves 60→70→85; 1102 misses IPPT 2 and declines 80→70; 1103 is a
  // YTT (all-zero) row; 1104 has a score but no run time (incomplete run).
  const IPPT_ROWS = [
    { d4: "1101", attempt: 1, pushups: 20, situps: 22, runTime: "13:30", score: 60 },
    { d4: "1101", attempt: 2, pushups: 28, situps: 30, runTime: "12:40", score: 70 },
    { d4: "1101", attempt: 3, pushups: 40, situps: 42, runTime: "11:10", score: 85 },
    { d4: "1102", attempt: 1, pushups: 36, situps: 38, runTime: "11:40", score: 80 },
    { d4: "1102", attempt: 3, pushups: 28, situps: 30, runTime: "12:40", score: 70 },
    { d4: "1103", attempt: 1, pushups: 0,  situps: 0,  runTime: "0:00",  score: 0 },
    { d4: "1104", attempt: 2, pushups: 30, situps: 30, runTime: "0:00",  score: 75 }
  ];

  await test("ipptSeriesByRecruit: valid scores keyed by attempt; YTT + zero-run rows excluded", () => {
    const h = loadHelpers(baseState());
    const series = h.ipptSeriesByRecruit(IPPT_ROWS);
    const byD4 = Object.fromEntries(series.map(r => [r.d4, r.byAttempt]));
    eq(JSON.stringify(byD4["1101"]), JSON.stringify({ 1: 60, 2: 70, 3: 85 }));
    eq(JSON.stringify(byD4["1102"]), JSON.stringify({ 1: 80, 3: 70 }), "missed attempt just absent");
    ok(!byD4["1103"], "all-zero YTT row contributes nothing");
    ok(!byD4["1104"], "zero run time excluded (same rule as the trend chart)");
  });

  await test("ipptPairedCohort: only recruits with BOTH attempts, for any pair", () => {
    const h = loadHelpers(baseState());
    const series = h.ipptSeriesByRecruit(IPPT_ROWS);
    const p13 = h.ipptPairedCohort(series, 1, 3);
    eq(p13.length, 2);
    const p1101 = p13.find(p => p.d4 === "1101");
    eq(p1101.s1, 60); eq(p1101.s2, 85); eq(p1101.delta, 25);
    eq(p13.find(p => p.d4 === "1102").delta, -10);
    // 1102 has no IPPT 2, so the 2→3 cohort is 1101 alone.
    const p23 = h.ipptPairedCohort(series, 2, 3);
    eq(p23.length, 1);
    eq(p23[0].d4, "1101");
  });

  await test("ipptNetDelta: latest taken vs first taken; single attempt = 0", () => {
    const h = loadHelpers(baseState());
    eq(h.ipptNetDelta({ byAttempt: { 1: 60, 2: 70, 3: 85 } }), 25);
    eq(h.ipptNetDelta({ byAttempt: { 1: 80, 3: 70 } }), -10, "gap bridged: last vs first");
    eq(h.ipptNetDelta({ byAttempt: { 2: 75 } }), 0);
  });
};
