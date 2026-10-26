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

  await test("chips In camp / Out of camp exclude each other; sort cycles asc, desc, off", () => {
    let st = s.NR.toggleChip(s.NR.blank(), "incamp");
    st = s.NR.toggleChip(st, "out");
    eq(JSON.stringify(st.chips), JSON.stringify(["out"]));
    st = s.NR.cycleSort(st, "bmi"); eq(st.sort.dir, "asc");
    st = s.NR.cycleSort(st, "bmi"); eq(st.sort.dir, "desc");
    st = s.NR.cycleSort(st, "bmi"); eq(st.sort, null);
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
