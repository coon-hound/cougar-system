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
};
