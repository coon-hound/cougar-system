// Master NR column registry (js/nr-columns.js). Loads the REAL helpers, state,
// render and forms scripts against the demo fixture (synthetic people only), so
// every column runs through the same helpers the browser uses.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const SEED = require("./e2e/fixtures/demo-seed.json");

function load(extraLocal) {
  const storageKey = /const STORAGE_KEY\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "js/state.js"), "utf8"))[1];
  const store = new Map();
  Object.entries(SEED).forEach(([k, v]) => {
    store.set(/^cougar-data(-v\d+)?$/.test(k) ? storageKey : k, JSON.stringify(v));
  });
  Object.entries(extraLocal || {}).forEach(([k, v]) => store.set(k, v));
  const sandbox = {
    console, Math, Date, JSON, String, Number, Array, Object, Boolean, RegExp,
    Set, Map, isNaN, parseInt, parseFloat, Intl,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    _store: store,
  };
  vm.createContext(sandbox);
  ["js/helpers.js", "js/state.js", "js/ippt-scoring.js", "js/nr-columns.js", "js/render.js", "js/forms.js"].forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
  vm.runInContext("this.STATE = STATE; this.NR = NR; loadLocal();", sandbox);
  return sandbox;
}

module.exports = async function run() {
  suite("nr-columns: the Master NR column registry");

  const s = load();

  await test("the fixture loaded into STATE", () => {
    ok(s.STATE.roster.length > 0, "roster rows: " + s.STATE.roster.length);
  });

  await test("column ids and labels are unique", () => {
    const ids = s.NR.COLUMNS.map(c => c.id);
    eq(new Set(ids).size, ids.length, "duplicate id in " + JSON.stringify(ids));
    // Labels are the CSV header keys, so a repeat would drop a column.
    const labels = s.NR.COLUMNS.map(c => c.label);
    eq(new Set(labels).size, labels.length, "duplicate label");
  });

  await test("every column has a known type and group", () => {
    const types = ["text", "enum", "bool", "number", "date"];
    s.NR.COLUMNS.forEach(c => {
      ok(types.includes(c.type), c.id + " type " + c.type);
      ok(s.NR.GROUPS.includes(c.group), c.id + " group " + c.group);
      ok(typeof c.get === "function", c.id + " has get()");
    });
  });

  await test("every getter, text and cell tolerates a blank record", () => {
    const ctx = s.NR.makeCtx("2026-10-22");
    s.NR.COLUMNS.forEach(c => {
      for (const r of [{}, { id: "" }, { id: "9999", role: "Commander" }]) {
        const t = s.NR.textOf(c, r, ctx);
        ok(typeof t === "string", c.id + " text is a string");
        ok(typeof s.NR.cellOf(c, r, ctx) === "string", c.id + " cell is a string");
        s.NR.sortVal(c, r, ctx);
      }
    });
  });

  await test("every column renders every seeded man without throwing", () => {
    const ctx = s.NR.makeCtx(vm.runInContext("todayISO()", s));
    s.STATE.roster.forEach(r => s.NR.COLUMNS.forEach(c => {
      // Call the raw getter, not the guarded getVal, so a broken column shows.
      c.get(r, ctx);
    }));
  });

  await test("In camp equals !outOfCampMap().has for the seed", () => {
    const today = vm.runInContext("todayISO()", s);
    // Put one man out so both answers are exercised.
    const r0 = s.STATE.roster.find(r => r.role !== "Commander");
    r0.outOfCamp = true; r0.outSince = today; r0.outReason = "Test";
    const map = s.outOfCampMap(today);
    const ctx = s.NR.makeCtx(today);
    ok(map.size > 0, "someone is out");
    s.STATE.roster.forEach(r => eq(s.NR.getVal(s.NR.COL.in_camp, r, ctx), !map.has(r.id), "in_camp for " + r.id));
    const chip = s.STATE.roster.filter(r => s.NR.CHIP.incamp.test(r, ctx)).length;
    eq(chip, s.STATE.roster.length - map.size, "In camp chip count");
    r0.outOfCamp = false;
  });

  await test("each preset references real column ids", () => {
    s.NR.PRESETS.forEach(p => {
      ok(p.cols.length > 0, p.id + " has columns");
      p.cols.forEach(id => ok(s.NR.COL[id], p.id + " -> " + id));
      (p.chips || []).forEach(id => ok(s.NR.CHIP[id], p.id + " chip " + id));
    });
    eq(new Set(s.NR.PRESETS.map(p => p.id)).size, s.NR.PRESETS.length, "preset ids unique");
  });

  await test("Default is exactly the old Roster columns", () => {
    const d = s.NR.presetById("default");
    eq(JSON.stringify(d.cols.map(id => s.NR.COL[id].label)),
      JSON.stringify(["4D", "Name", "Role", "Status", "Camp", "BMI", "RSIs"]));
  });

  await test("sensitive fields are off by default and only in Contacts / NOK", () => {
    s.NR.PRESETS.forEach(p => {
      const hits = p.cols.filter(id => s.NR.SENSITIVE.has(id));
      if (p.id === "contacts") ok(hits.length === s.NR.SENSITIVE.size, "contacts carries all of them");
      else eq(hits.length, 0, p.id + " carries no sensitive column");
    });
    eq(s.NR.SENSITIVE.size, 8);
  });

  await test("state round-trips and a corrupt store falls back to Default", () => {
    const st = s.NR.applyPreset(s.NR.blank(), "medical");
    ok(s.NR.save(st), "saved");
    eq(s.NR.load().preset, "medical");
    s._store.set(s.NR.LS_KEY, "{not json");
    eq(s.NR.load().preset, "default");
    s._store.set(s.NR.LS_KEY, JSON.stringify({ preset: "nope", cols: ["bogus", "name"], chips: ["x", "out"], sort: { id: "zz" } }));
    const l = s.NR.load();
    eq(l.preset, "default");
    eq(JSON.stringify(l.cols), JSON.stringify(["name"]));
    eq(JSON.stringify(l.chips), JSON.stringify(["out"]));
    eq(l.sort, null);
    s._store.delete(s.NR.LS_KEY);
  });

  await test("a throwing localStorage costs the preference, never the view", () => {
    const real = s.localStorage;
    s.localStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
    try {
      eq(s.NR.load().preset, "default");
      eq(s.NR.save(s.NR.blank()), false);
    } finally { s.localStorage = real; }
  });

  await test("chips: the label shows only, the − hides, the same tap clears; In camp / Out of camp clear each other", () => {
    const N = s.NR;
    let st = N.toggleChip(N.blank(), "leave", "in");
    eq(N.chipState(st, "leave"), "in");
    st = N.toggleChip(st, "leave", "out");
    eq(N.chipState(st, "leave"), "out", "one tap goes straight from show only to hide");
    eq(JSON.stringify([st.chips, st.xchips]), JSON.stringify([[], ["leave"]]));
    st = N.toggleChip(st, "leave", "out");
    eq(JSON.stringify([st.chips, st.xchips]), JSON.stringify([[], []]), "tapping the − again clears");
    st = N.toggleChip(N.toggleChip(N.blank(), "leave", "in"), "leave", "in");
    eq(N.chipState(st, "leave"), "", "tapping the label again clears");

    // Complements: setting either one clears the other, whichever state it was in.
    st = N.toggleChip(N.toggleChip(N.blank(), "incamp", "in"), "out", "in");
    eq(JSON.stringify(st.chips), JSON.stringify(["out"]));
    st = N.toggleChip(N.toggleChip(N.blank(), "incamp", "out"), "out", "in");
    eq(JSON.stringify([st.chips, st.xchips]), JSON.stringify([["out"], []]), "hidden In camp dropped by Out of camp");
    st = N.toggleChip(st, "leave", "out");
    eq(JSON.stringify([st.chips, st.xchips]), JSON.stringify([["out"], ["leave"]]), "unrelated chips stack");
    eq(N.toggleChip(st, "nope", "in"), st, "an unknown chip changes nothing");

    st = N.cycleSort(st, "bmi"); eq(st.sort.dir, "asc");
    st = N.cycleSort(st, "bmi"); eq(st.sort.dir, "desc");
    st = N.cycleSort(st, "bmi"); eq(st.sort, null);
  });

  await test("Mounted / Dismounted chips: a mixed role counts on both sides, commanders on neither", () => {
    const ctx = s.NR.makeCtx("2026-11-16");
    const men = vm.runInContext(`normalizeRoster([
      { id: "0091", name: "TEST CMD", role: "Commander", rank: "3SG" },
      { id: "9901", name: "TEST DRIVER", role: "Recruit", billet: "Hunter Driver" },
      { id: "9902", name: "TEST LMG", role: "Recruit", billet: "1 LMG" },
      { id: "9903", name: "TEST MIXED", role: "Recruit", billet: "2 LMG / Gunner" },
    ])`, s);
    const pick = st => s.NR.apply(men, Object.assign(s.NR.blank(), st), ctx, "").map(r => r.id).join(",");
    eq(pick({ chips: ["mounted"] }), "9901,9903");
    eq(pick({ chips: ["dismounted"] }), "9902,9903");
    eq(pick({ xchips: ["mounted"] }), "0091,9902");
  });

  await test("an excluded chip hides the men it matches", () => {
    const today = vm.runInContext("todayISO()", s);
    const r0 = s.STATE.roster.find(r => r.role !== "Commander");
    r0.outOfCamp = true; r0.outSince = today; r0.outReason = "Test";
    try {
      const ctx = s.NR.makeCtx(today);
      const rows = s.STATE.roster;
      const st = Object.assign(s.NR.blank(), { xchips: ["out"] });
      const kept = s.NR.apply(rows, st, ctx, "").map(r => r.id);
      ok(!kept.includes(r0.id), "the man out of camp is hidden");
      eq(kept.length, rows.length - 1);
      const only = s.NR.apply(rows, Object.assign(s.NR.blank(), { chips: ["out"] }), ctx, "").map(r => r.id);
      eq(JSON.stringify(only), JSON.stringify([r0.id]), "show only is the complement");
    } finally { r0.outOfCamp = false; }
  });

  // Quals is a multi-valued column: one man, several values.
  const qualMen = () => vm.runInContext(`normalizeRoster([
    { id: "9901", name: "TEST BOTH", role: "Recruit", quals: "LMG LF, M203 LF" },
    { id: "9902", name: "TEST LMG", role: "Recruit", quals: "LMG LF" },
    { id: "9903", name: "TEST MAT", role: "Recruit", quals: "MATADOR LF" },
    { id: "9904", name: "TEST NONE", role: "Recruit", quals: "" },
  ])`, s);

  await test("show only / exclude on a multi-valued column: any, all, blank, and both at once", () => {
    const ctx = s.NR.makeCtx("2026-11-16");
    const men = qualMen();
    const pick = q => s.NR.apply(men, Object.assign(s.NR.blank(), { filters: { quals: q } }), ctx, "").map(r => r.id).join(",");
    eq(pick({ in: ["LMG LF"] }), "9901,9902", "show only LMG LF");
    eq(pick({ out: ["LMG LF"] }), "9903,9904", "excluding LMG LF hides the man who also holds M203 LF");
    eq(pick({ in: ["LMG LF", "M203 LF"] }), "9901,9902", "any of the + values");
    eq(pick({ in: ["LMG LF", "M203 LF"], all: true }), "9901", "all of the + values");
    eq(pick({ in: [""] }), "9904", "a man with no quals is pickable as (blank)");
    eq(pick({ out: [""] }), "9901,9902,9903", "and excludable");
    eq(pick({ in: ["LMG LF"], out: ["M203 LF"] }), "9902", "show only and exclude on one column");
    // An exclusion is not a frozen allowlist: a qual nobody held when the
    // filter was set still shows.
    men.push(...vm.runInContext(`normalizeRoster([{ id: "9905", name: "TEST CPR", role: "Recruit", quals: "CPR" }])`, s));
    eq(pick({ out: ["MATADOR LF"] }), "9901,9902,9904,9905");
  });

  await test("an older saved ticked-list still means what it meant", () => {
    const ctx = s.NR.makeCtx("2026-11-16");
    const men = qualMen();
    const st = s.NR.sanitize({ filters: { quals: { in: ["MATADOR LF", ""] }, kind: { in: [] } } });
    eq(s.NR.apply(men, st, ctx, "").map(r => r.id).join(","), "9903,9904");
    // Everything unticked used to show nobody; it now filters nothing.
    ok(!("kind" in st.filters), "an empty list is no filter");
  });

  await test("number and date columns take a range; blanks drop out of a range", () => {
    const men = vm.runInContext(`normalizeRoster([
      { id: "9901", name: "TEST A", role: "Recruit", age: "18" },
      { id: "9902", name: "TEST B", role: "Recruit", age: "20" },
      { id: "9903", name: "TEST C", role: "Recruit", age: "25" },
      { id: "9904", name: "TEST D", role: "Recruit", age: "" },
    ])`, s);
    const leave = s.STATE.leave;
    s.STATE.leave = [
      { id: "L1", d4: "9901", startDate: "1 Dec 2026", endDate: "3 Dec 2026", type: "AL" },
      { id: "L2", d4: "9902", startDate: "20 Dec 2026", endDate: "22 Dec 2026", type: "AL" },
    ];
    try {
      const ctx = s.NR.makeCtx("2026-11-16");
      const pick = (id, f) => s.NR.apply(men, Object.assign(s.NR.blank(), { filters: { [id]: f } }), ctx, "").map(r => r.id).join(",");
      eq(pick("age", { min: 19 }), "9902,9903");
      eq(pick("age", { max: "20" }), "9901,9902", "a typed string bound works");
      eq(pick("age", { min: 20, max: 20 }), "9902");
      eq(pick("age", { out: [""] }), "9901,9902,9903", "values still work on a number column");
      eq(pick("next_leave", { from: "2026-12-10" }), "9902");
      eq(pick("next_leave", { to: "2026-12-10" }), "9901");
      eq(pick("next_leave", { from: "2026-11-30", to: "2026-12-31" }), "9901,9902");
      eq(pick("next_leave", { in: [""] }), "9903,9904", "no next leave is (blank)");
      eq(pick("next_leave", { in: ["20 Dec 2026"] }), "9902", "a date column's values are its dates");
    } finally { s.STATE.leave = leave; }
  });

  await test("editing: a value is one tap to show only or hide; All matching moves a group", () => {
    const N = s.NR;
    let st = N.toggleValue(N.blank(), "quals", "LMG LF", "in");
    eq(JSON.stringify(st.filters.quals), JSON.stringify({ in: ["LMG LF"] }));
    st = N.toggleValue(st, "quals", "LMG LF", "out");
    eq(JSON.stringify(st.filters.quals), JSON.stringify({ out: ["LMG LF"] }), "show only to hide in one tap");
    st = N.toggleValue(st, "quals", "LMG LF", "out");
    ok(!("quals" in st.filters), "the same tap again removes the filter outright");
    st = N.toggleValue(N.blank(), "quals", "CPR", "out");
    eq(JSON.stringify(st.filters.quals), JSON.stringify({ out: ["CPR"] }), "hiding is one tap from nothing");

    const group = ["LMG LF", "M203 LF"];
    st = N.toggleValues(N.toggleValue(N.blank(), "quals", "LMG LF", "in"), "quals", group, "in");
    eq(JSON.stringify(st.filters.quals.in), JSON.stringify(group), "mixed goes all to the tapped state");
    st = N.toggleValues(st, "quals", group, "in");
    ok(!("quals" in st.filters), "all already there: the group clears");
    st = N.toggleValues(N.blank(), "quals", group, "out");
    eq(JSON.stringify(st.filters.quals.out), JSON.stringify(group));

    st = N.setMatchAll(N.setValues(N.blank(), "quals", group, "in"), "quals", true);
    eq(st.filters.quals.all, true);
    st = N.setValues(st, "quals", group, "");
    ok(!("quals" in st.filters), "match-all alone is not a filter");

    st = N.setRange(N.blank(), "age", "min", "18");
    eq(st.filters.age.min, 18);
    st = N.setRange(st, "age", "min", "");
    ok(!("age" in st.filters), "clearing the last bound removes the filter");
    st = N.clearFilter(N.toggleValue(N.blank(), "quals", "CPR", "in"), "quals");
    eq(JSON.stringify(st.filters), "{}");
  });

  await test("a saved view brings its filters back; a column layout keeps the filters in force", () => {
    const N = s.NR;
    let st = N.toggleValue(N.toggleChip(N.blank(), "leave", "out"), "plt", "2", "in");
    st = N.saveView(st, "  PL 2 not on leave  ");
    const v = st.custom[0];
    eq(v.label, "PL 2 not on leave");
    eq(st.preset, v.id);
    eq(JSON.stringify(v.cols), JSON.stringify(N.presetById("default").cols));
    eq(JSON.stringify([v.xchips, v.filters]), JSON.stringify([["leave"], { plt: { in: ["2"] } }]));

    // A layout switch keeps the filters; the saved view restores its own.
    st = N.applyPreset(st, "ippt");
    eq(JSON.stringify([st.xchips, st.filters]), JSON.stringify([["leave"], { plt: { in: ["2"] } }]), "IPPT layout keeps them");
    st = N.clearFilter(Object.assign({}, st, { xchips: [] }), "plt");
    st = N.applyPreset(st, v.id);
    eq(JSON.stringify([st.xchips, st.filters]), JSON.stringify([["leave"], { plt: { in: ["2"] } }]), "the view brings them back");

    // A preset's own chip comes on with it and goes when you leave it.
    st = N.applyPreset(N.blank(), "out");
    eq(JSON.stringify(st.chips), JSON.stringify(["out"]));
    st = N.applyPreset(st, "default");
    eq(JSON.stringify(st.chips), JSON.stringify([]));
    // A sort on a column the new layout lacks is dropped; one it has stays.
    st = N.applyPreset(Object.assign(N.blank(), { sort: { id: "bmi", dir: "asc" } }), "ippt");
    eq(st.sort, null);
    st = N.applyPreset(Object.assign(N.blank(), { sort: { id: "name", dir: "asc" } }), "ippt");
    eq(st.sort.id, "name");

    // The saved view survives a save and reload, junk filters dropped.
    s._store.set(N.LS_KEY, JSON.stringify(Object.assign({}, st, { custom: [Object.assign({}, v, { filters: { plt: { in: ["2"] }, bogus: { in: ["x"] } } })] })));
    try {
      const l = N.load();
      eq(JSON.stringify(l.custom[0].filters), JSON.stringify({ plt: { in: ["2"] } }));
      eq(JSON.stringify(l.custom[0].xchips), JSON.stringify(["leave"]));
    } finally { s._store.delete(N.LS_KEY); }
  });

  await test("2.4 km ranges are seconds, said as mm:ss; an old next-leave value reduces to its date", () => {
    const N = s.NR, C = N.COL;
    eq(C.ippt_run.range.parse("11:00"), 660);
    eq(C.ippt_run.range.parse("11:"), null, "half-typed is no bound");
    eq(N.describeFilter(C.ippt_run, { max: 660 }), "11:00 or less");
    eq(N.describeFilter(C.ippt_run, { min: 600, max: 660 }), "10:00 to 11:00");
    const st = N.sanitize({ filters: { next_leave: { in: ["1 Dec 2026 (AL)"] }, next_appt: { out: ["3 Dec 2026 0930 - Dental", ""] } } });
    eq(JSON.stringify(st.filters.next_leave), JSON.stringify({ in: ["1 Dec 2026"] }));
    eq(JSON.stringify(st.filters.next_appt), JSON.stringify({ out: ["3 Dec 2026", ""] }));
  });

  await test("a filter in words, for its pill", () => {
    const N = s.NR, C = N.COL;
    const d = (id, f, full) => N.describeFilter(C[id], f, full);
    eq(d("status", { in: ["MC", "LD"], out: ["RSO"] }), "MC or LD, not RSO");
    eq(d("status", { out: [""] }), "not Active", "a blank Status is Active, as the column shows it");
    eq(d("plt", { in: ["1", "2"] }), "PL 1 or PL 2");
    eq(d("plt", { out: [""] }), "not COY HQ");
    eq(d("quals", { in: ["LMG LF", "M203 LF"], all: true }), "LMG LF and M203 LF");
    eq(d("quals", { in: ["A", "B", "C"] }), "A, B or C");
    eq(d("quals", { in: ["A", "B", "C", "D", "E"] }), "A, B or 3 more");
    eq(d("quals", { in: ["A", "B", "C", "D", "E"] }, true), "A, B, C, D or E", "the title lists every value");
    eq(d("billet", { in: [""] }), "(blank)");
    eq(d("age", { min: 18, max: 25 }), "18 to 25");
    eq(d("age", { min: 61 }), "61 or more");
    eq(d("age", { max: 60 }), "60 or less");
    const short = iso => vm.runInContext(`isoToShortDate(${JSON.stringify(iso)})`, s);
    eq(d("next_leave", { from: "2026-12-01" }), "from " + short("2026-12-01"));
    eq(d("next_leave", { from: "2026-12-01", to: "2026-12-31" }), `${short("2026-12-01")} to ${short("2026-12-31")}`);
    eq(d("next_leave", { from: "2026-12-01", to: "2026-12-01" }), "on " + short("2026-12-01"));
    eq(d("status", null), "", "no filter, no words");
    eq(d("status", { min: 3 }), "", "a range means nothing on a value column");
  });

  await test("a saved view keeps show only, exclude, match-all and ranges; junk is dropped", () => {
    s._store.set(s.NR.LS_KEY, JSON.stringify({
      preset: "default",
      chips: ["leave", "leave"], xchips: ["leave", "out", "nope"],
      filters: {
        quals: { in: ["LMG LF", 7], out: ["CPR", "LMG LF"], all: true },
        plt: { in: ["1"], all: true },
        age: { min: "18", max: "" },
        bmi: { from: "2026-01-01" },
        next_leave: { from: "2026-12-01", to: "not a date" },
        kind: { in: [] },
        bogus: { in: ["x"] },
      },
    }));
    try {
      const l = s.NR.load();
      eq(JSON.stringify(l.chips), JSON.stringify(["leave"]));
      eq(JSON.stringify(l.xchips), JSON.stringify(["out"]), "a chip cannot be both shown only and excluded");
      eq(JSON.stringify(l.filters.quals), JSON.stringify({ in: ["LMG LF", "7"], out: ["CPR"], all: true }));
      eq(JSON.stringify(l.filters.plt), JSON.stringify({ in: ["1"] }), "match-all only on a multi-valued column");
      eq(JSON.stringify(l.filters.age), JSON.stringify({ min: 18 }));
      eq(JSON.stringify(l.filters.next_leave), JSON.stringify({ from: "2026-12-01" }));
      ok(!("bmi" in l.filters) && !("kind" in l.filters) && !("bogus" in l.filters), "nothing left to filter is dropped");
      eq(JSON.stringify(s.NR.activeFilterIds(l)), JSON.stringify(["plt", "quals", "age", "next_leave"].sort((a, b) =>
        s.NR.COLUMNS.findIndex(c => c.id === a) - s.NR.COLUMNS.findIndex(c => c.id === b))), "pills run in catalogue order");
      ok(s.NR.narrowed(l), "narrowed");
      ok(!s.NR.narrowed(s.NR.blank()), "a blank view is not narrowed");
    } finally { s._store.delete(s.NR.LS_KEY); }
  });

  await test("filters by type narrow rows; CSV keys are the visible labels", () => {
    const ctx = s.NR.makeCtx(vm.runInContext("todayISO()", s));
    const rows = s.STATE.roster;
    let st = s.NR.blank();
    st.filters = { kind: { in: ["Commander"] } };
    const cmd = s.NR.apply(rows, st, ctx, "");
    ok(cmd.length > 0 && cmd.every(r => r.role === "Commander"), "enum filter");
    st.filters = { name: { contains: rows[0].name.slice(0, 3) } };
    ok(s.NR.apply(rows, st, ctx, "").some(r => r.id === rows[0].id), "text filter");
    st.filters = { rsis: { min: "999" } };
    eq(s.NR.apply(rows, st, ctx, "").length, 0, "number filter");
    st.filters = {};
    const cols = s.NR.visibleCols(st);
    const csv = s.NR.csvRows(rows, cols, ctx);
    eq(JSON.stringify(Object.keys(csv[0])), JSON.stringify(cols.map(c => c.label)));
  });

  await test("section role filters on each part of a combined role, case-folded", () => {
    const ctx = s.NR.makeCtx(vm.runInContext("todayISO()", s));
    const men = vm.runInContext(`normalizeRoster([
      { id: "9901", name: "TEST GUNNER", role: "Recruit", billet: "Gunner" },
      { id: "9902", name: "TEST MIXED", role: "Recruit", billet: "2 LMG / Gunner" },
      { id: "9903", name: "TEST MAT", role: "Recruit", billet: "2 MAT" },
      { id: "9904", name: "TEST BRONCO", role: "Recruit", billet: "BRONCO OPERATOR" },
      { id: "9905", name: "TEST NONE", role: "Recruit", billet: "" },
      { id: "9906", name: "TEST RUNNER", role: "Recruit", billet: "(2GL) / PC Runner" },
    ])`, s);
    const pick = f => s.NR.apply(men, Object.assign(s.NR.blank(), { filters: f }), ctx, "").map(r => r.id);
    eq(JSON.stringify(pick({ billet: { in: ["Gunner"] } })), JSON.stringify(["9901", "9902"]));
    eq(JSON.stringify(pick({ billet: { in: ["Gunner", "2 MAT"] } })), JSON.stringify(["9901", "9902", "9903"]), "values on one column are OR");
    eq(JSON.stringify(pick({ billet: { in: ["Bronco Operator"] } })), JSON.stringify(["9904"]), "case folds onto the suggestion");
    eq(JSON.stringify(pick({ billet: { in: ["2GL"] } })), JSON.stringify(["9906"]), "brackets are stripped");
    eq(JSON.stringify(pick({ billet: { in: [""] } })), JSON.stringify(["9905"]), "blank stays filterable");
    eq(JSON.stringify(pick({ billet: { in: ["Gunner"] }, mount: { in: ["Mounted"] } })), JSON.stringify(["9901"]), "different columns are AND");
    eq(s.NR.textOf(s.NR.COL.billet, men[1], ctx), "2 LMG / Gunner", "the cell and CSV keep the role as written");
    eq(vm.runInContext("mountOf", s)(men[3]), "mounted", "Bronco Operator is crew");
  });
};
