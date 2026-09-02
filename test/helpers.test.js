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

  // ── Chained (back-to-back) status runs ──────────────────
  // An extended MC is a SECOND record starting the day the first ends + 1.
  // statusRun merges those so every "until when" reads the real end date; a
  // genuine gap (back in camp in between) must stay two separate absences.
  suite("helpers: statusRun (back-to-back re-issued statuses)");

  const chainState = () => {
    const s = baseState();
    s.medical = [
      // 1101: MC 25–26 Jun extended by a second MC 27–28 Jun → one run 25–28.
      { d4: "1101", status: "MC", reason: "Fever", startDate: "25 Jun 2026", endDate: "26 Jun 2026" },
      { d4: "1101", status: "MC", reason: "Fever", startDate: "27 Jun 2026", endDate: "28 Jun 2026" },
      // 1102: MC 25–26 Jun, then a fresh MC after two days back → two runs.
      { d4: "1102", status: "MC", reason: "Flu", startDate: "25 Jun 2026", endDate: "26 Jun 2026" },
      { d4: "1102", status: "MC", reason: "Flu", startDate: "29 Jun 2026", endDate: "30 Jun 2026" },
      // 1103: a long MC with a shorter overlapping re-issue inside it.
      { d4: "1103", status: "MC", reason: "Knee", startDate: "20 Jun 2026", endDate: "30 Jun 2026" },
      { d4: "1103", status: "MC", reason: "Knee", startDate: "24 Jun 2026", endDate: "26 Jun 2026" },
      // 1104: an away MC followed by an in-camp one — different dispositions,
      // so they must NOT merge into one out-of-camp span.
      { d4: "1104", status: "MC", reason: "Cough", startDate: "25 Jun 2026", endDate: "26 Jun 2026" },
      { d4: "1104", status: "MC", reason: "Cough", startDate: "27 Jun 2026", endDate: "28 Jun 2026", inCamp: true }
    ];
    return s;
  };

  await test("adjacent re-issues merge into one run", () => {
    const h = loadHelpers(chainState());
    const run = h.medStatusRun(h.STATE.medical[0]);
    eq(run.startIso, "2026-06-25", "run starts at the first record");
    eq(run.endIso, "2026-06-28", "run ends at the extension");
    eq(run.days, 4, "4 days total");
    ok(run.chained, "flagged as chained");
  });

  await test("a gap keeps two absences separate", () => {
    const h = loadHelpers(chainState());
    const run = h.medStatusRun(h.STATE.medical[2]);
    eq(run.endIso, "2026-06-26", "today's run still ends 26 Jun");
    ok(!run.chained, "not chained across a real gap");
  });

  await test("an overlapping re-issue does not shorten the run", () => {
    const h = loadHelpers(chainState());
    // Picking the LATEST-starting record (what dedupeActiveRecordsByFamily
    // does) used to report 26 Jun as the end, hiding the longer MC underneath.
    const run = h.medStatusRun(h.STATE.medical[5]);
    eq(run.startIso, "2026-06-20");
    eq(run.endIso, "2026-06-30");
  });

  await test("away and consume-in-camp MCs never merge", () => {
    const h = loadHelpers(chainState());
    const run = h.medStatusRun(h.STATE.medical[6]);
    eq(run.endIso, "2026-06-26", "away run ends before the in-camp record");
    ok(!run.chained, "different dispositions are different runs");
  });

  await test("outOfCampMap carries the merged until/back date", () => {
    const h = loadHelpers(chainState());
    const info = h.outOfCampMap(DATE).get("1101");
    eq(info.kind, "medical");
    eq(info.until, "2026-06-28", "out until the end of the whole run");
    eq(info.back, "2026-06-29", "back the day after");
    // The recruit whose MC genuinely ends 26 Jun is back on the 27th.
    eq(h.outOfCampMap(DATE).get("1102").back, "2026-06-27");
  });

  await test("recovery tag waits for the run to end, and prints once", () => {
    const h = loadHelpers(chainState());
    const [first, extension] = h.STATE.medical;
    // 27 Jun: the first record has "ended" but the extension carries it on.
    eq(h.medStatusTag(first, "2026-06-27"), null, "no MC+1 mid-run");
    eq(h.medStatusTag(extension, "2026-06-27").tag, "MC", "still on MC");
    // 29 Jun: the run is over — only the record that closed it ghost-tags.
    eq(h.medStatusTag(first, "2026-06-29"), null, "inner record stays silent");
    eq(h.medStatusTag(extension, "2026-06-29").tag, "MC+1");
  });

  await test("a copy of a record does not chain with its own original", () => {
    // Renderers pass spread copies of a row; a copy must not look extended.
    const s = baseState();
    s.leave = [{ id: 7, d4: "1101", type: "Off-in-Lieu", startDate: "25 Jun 2026", endDate: "26 Jun 2026" }];
    const h = loadHelpers(s);
    const run = h.leaveRun({ ...s.leave[0], startIso: "2026-06-25", endIso: "2026-06-26" });
    ok(!run.chained, "single record stays unchained");
    eq(run.endIso, "2026-06-26");
  });

  await test("back-to-back leave of the same type is one absence", () => {
    const s = baseState();
    s.leave = [
      { d4: "1101", type: "Off-in-Lieu", startDate: "25 Jun 2026", endDate: "26 Jun 2026" },
      { d4: "1101", type: "Off-in-Lieu", startDate: "27 Jun 2026", endDate: "28 Jun 2026" },
      // A different type on adjacent days stays its own record.
      { d4: "1102", type: "Off-in-Lieu", startDate: "25 Jun 2026", endDate: "26 Jun 2026" },
      { d4: "1102", type: "Annual Leave", startDate: "27 Jun 2026", endDate: "28 Jun 2026" }
    ];
    const h = loadHelpers(s);
    eq(h.leaveRun(s.leave[0]).endIso, "2026-06-28");
    ok(h.leaveRun(s.leave[0]).chained, "same type chains");
    eq(h.leaveRun(s.leave[2]).endIso, "2026-06-26");
    eq(h.outOfCampMap(DATE).get("1101").back, "2026-06-29", "back after both blocks");
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
