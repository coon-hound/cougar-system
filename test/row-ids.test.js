// Unit tests for row identity: nextId (js/helpers.js) and the id coercion the
// state.js normalizers apply at the read boundary.
//
// These pin two bugs that were live in production, not hypotheticals:
//
//   * nextId seeded a counter with Math.random()*9000+1000 once per SESSION, so
//     two devices collided and then minted identical ids in lockstep. The live
//     sheet has 11 Medical and 5 Leave rows whose id belongs to a DIFFERENT
//     person's record. Because the backend resolves an id to the FIRST matching
//     row, editing one silently overwrote the other.
//
//   * Row ids were compared with `row.id === +editId`. That holds only while
//     the store types the id column as a number. Any text-typed id compares
//     false, and submitMedical then falls through its edit branch and APPENDS a
//     duplicate rather than updating in place.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function load(file, extra) {
  const sandbox = Object.assign({
    STATE: { roster: [], medical: [], leave: [] },
    console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat, localStorage: null
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, { filename: file });
  // `const`/`let` at a script's top level are lexical, not properties of the
  // sandbox global, so nextId/normId are unreachable as sandbox.nextId. Reach
  // them by evaluating in the same context instead.
  sandbox.__eval = expr => vm.runInContext(expr, sandbox);
  return sandbox;
}

// state.js reaches for localStorage at load time; a stub is enough to get the
// normalizers defined.
function loadState() {
  const store = {};
  return load("js/state.js", {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    window: {}, document: { addEventListener() {} }
  });
}

module.exports = async function run() {
  suite("row ids: nextId is unique across devices");

  await test("nextId returns a string, not a number", () => {
    const h = load("js/helpers.js");
    eq(h.__eval("typeof nextId()"), "string");
  });

  await test("50k ids in a tight loop are all distinct", () => {
    const h = load("js/helpers.js");
    const n = h.__eval("(() => { const s = new Set(); for (let i=0;i<50000;i++) s.add(nextId()); return s.size; })()");
    eq(n, 50000);
  });

  await test("two independent 'devices' do not collide", () => {
    // The old generator's failure mode exactly: two fresh loads of the module,
    // each minting a run of ids. Under the random-seeded counter these
    // overlapped whenever the seeds matched; they must never overlap now.
    const mint = n => load("js/helpers.js")
      .__eval(`(() => { const o = []; for (let i=0;i<${n};i++) o.push(nextId()); return o; })()`);
    const idsA = new Set(mint(5000));
    const idsB = new Set(mint(5000));
    const overlap = [...idsA].filter(id => idsB.has(id));
    eq(overlap.length, 0);
  });

  await test("an id never collides with a legacy numeric id under ===", () => {
    // Legacy rows carry ids like "1404". A newly minted id must not be able to
    // equal one after the String coercion the normalizers apply.
    const h = load("js/helpers.js");
    const ids = h.__eval("(() => { const o = []; for (let i=0;i<1000;i++) o.push(nextId()); return o; })()");
    for (const id of ids) ok(!/^\d+$/.test(id), "minted id must not be purely numeric");
  });

  suite("row ids: normalizers pin ids to strings at the read boundary");

  const layers = [
    ["normalizeMedical", "medical"],
    ["normalizeLeave", "leave"],
    ["normalizeAttendance", "attendance"],
    ["normalizeConductDetail", "conductDetail"],
    ["padD4OnLayer", "ippt/rm/soc/polar/appointments/conducts"]
  ];

  for (const [fn, label] of layers) {
    await test(`${fn} (${label}) turns a numeric id into a string`, () => {
      const s = loadState();
      const out = s[fn]([{ id: 1404, d4: 1101 }]);
      eq(typeof out[0].id, "string");
      eq(out[0].id, "1404");
    });
  }

  await test("a null or missing id becomes the empty string, never null", () => {
    const s = loadState();
    eq(s.padD4OnLayer([{ id: null, d4: "1101" }])[0].id, "");
    eq(s.normalizeMedical([{ id: undefined, d4: "1101" }])[0].id, "");
  });

  await test("a text id survives untouched, trimmed", () => {
    const s = loadState();
    eq(s.padD4OnLayer([{ id: "  mtzubtxx-afnix7  " }])[0].id, "mtzubtxx-afnix7");
  });

  await test("the comparison that broke: normalized id === editId from the DOM", () => {
    // submitMedical reads a hidden input, which is ALWAYS a string. Before the
    // fix it coerced with `+`, so "1404" === 1404 was false and the edit became
    // an append. After normalization both sides are strings.
    const s = loadState();
    const row = s.normalizeMedical([{ id: 1404, d4: "1101" }])[0];
    const editIdFromDom = "1404";              // what gv("f-entry-id") returns
    ok(row.id === editIdFromDom, "row must match its own id read back from the form");
    ok(!(row.id === +editIdFromDom), "and must NOT match the old +-coerced form");
  });

  await test("roster ids stay padD4-canonical strings", () => {
    const s = loadState();
    const out = s.normalizeRoster([
      { id: 1, name: "Cmdr" }, { "4d": "C1101", name: "Rec" }
    ]);
    eq(out[0].id, "0001");
    eq(out[1].id, "1101");
  });
};
