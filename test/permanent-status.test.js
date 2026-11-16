// Permanent medical statuses: a restriction with no end date (e.g. a PERM
// excuse) that stays active from its start until someone removes it.
//
// Pins the read side (active, recovery tags, duration labels), the parade line
// and the parser reading that line back, since a parade state is filed and
// later compared.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function load(state) {
  const store = new Map();
  const sandbox = {
    STATE: state, console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    }
  };
  vm.createContext(sandbox);
  const src = ["js/helpers.js", "js/state.js", "js/parade-compare.js", "js/forms.js"]
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n")
    + "\n;this.generateParadeStateText = generateParadeStateText;"
    + "this.parseParadeState = parseParadeState;"
    + "this.normalizeMedical = normalizeMedical;"
    + "this.medStatusActive = medStatusActive;"
    + "this.medStatusTag = medStatusTag;"
    + "this.medDurationLabel = medDurationLabel;"
    + "this.paradeStatusLabel = paradeStatusLabel;"
    + "this.paradeDuration = paradeDuration;"
    + "this.currentMedicalEffectiveAll = currentMedicalEffectiveAll;"
    + "this.__setState = s => { Object.keys(STATE).forEach(k => { delete STATE[k]; }); Object.assign(STATE, s); return STATE; };";
  vm.runInContext(src, sandbox, { filename: "permanent-bundle.js" });
  sandbox.STATE = sandbox.__setState(state);
  return sandbox;
}

const DATE = "2026-11-16";

// Invented names only.
const baseState = extra => Object.assign({
  roster: [
    { id: "1101", role: "Recruit", rank: "PTE", name: "Tan Wei Ming" },
    { id: "1102", role: "Recruit", rank: "PTE", name: "Lim Jun Wei" }
  ],
  medical: [], leave: [], appointments: [], attendance: [], customStatuses: [], msk: []
}, extra || {});

const perm = over => Object.assign({
  id: "p1", d4: "1101", status: "Excuse Boots", reason: "Eczema",
  startDate: "01 Oct 2026", endDate: "", inCamp: false, location: "", permanent: true
}, over || {});

function section(text, label) {
  const head = new RegExp("^" + label + ": (\\d+)$");
  const lines = [];
  let inside = false, claimed = 0;
  text.split("\n").forEach(l => {
    const m = head.exec(l);
    if (m) { inside = true; claimed += +m[1]; return; }
    if (inside && /^\d+\. /.test(l)) { lines.push(l); return; }
    inside = false;
  });
  return { lines, claimed };
}

module.exports = async function run() {
  suite("permanent status: read side");

  await test("the flag survives the read boundary as a real boolean", () => {
    const b = load(baseState());
    eq(b.normalizeMedical([{ id: "a", permanent: "true" }, { id: "b", permanent: "FALSE" }, { id: "c" }]).map(r => r.permanent),
       [true, false, false]);
  });

  await test("active from its start, with no end", () => {
    const b = load(baseState());
    ok(!b.medStatusActive(perm(), "2026-09-30"), "not before it starts");
    ok(b.medStatusActive(perm(), "2026-10-01"), "on its start");
    ok(b.medStatusActive(perm(), "2031-01-01"), "years later");
    ok(!b.medStatusActive(perm({ permanent: false }), DATE), "the same row without the flag is not active");
  });

  await test("a permanent LD never gets a +1/+2 recovery tag", () => {
    const b = load(baseState());
    eq(b.medStatusTag(perm({ status: "LD" }), DATE), { tag: "LD", ghostDay: 0 });
  });

  await test("it shows on the dashboard's live statuses", () => {
    const b = load(baseState({ medical: [perm()] }));
    const all = b.currentMedicalEffectiveAll(DATE);
    eq(all.length, 1);
    eq(all[0].statuses[0].tag, "Excuse Boots");
  });

  await test("duration labels say Permanent", () => {
    const b = load(baseState());
    eq(b.medDurationLabel(perm()), "01 Oct 2026 – Permanent");
    eq(b.paradeStatusLabel(perm(), DATE, null), "PERM Excuse Boots");
    eq(b.paradeDuration(perm(), null), "011026 - PERM");
  });

  suite("permanent status: the parade line");

  await test("files under STATUS as PERM, dated SINCE its start, and parses back", () => {
    const b = load(baseState({ medical: [perm()] }));
    const text = b.generateParadeStateText("FP", DATE, "0700");
    const st = section(text, "STATUS");
    eq(st.claimed, 1, text);
    eq(st.lines[0], "1. 1101 PTE TAN WEI MING - PERM EXCUSE BOOTS (Eczema) (SINCE 011026)");
    ok(/^COMPANY: 2\/2$/m.test(text), "an in-camp restriction, so nobody is away");
    const parsed = b.parseParadeState(text);
    eq(parsed.unparsed.length, 0, "nothing unparsed: " + JSON.stringify(parsed.unparsed));
    eq(parsed.warnings.length, 0, "no warnings: " + JSON.stringify(parsed.warnings));
    const p = parsed.people.find(x => x.d4 === "1101");
    ok(p && p.section === "MEDICAL_STATUS", "parsed under STATUS: " + JSON.stringify(p));
    ok(/PERM EXCUSE BOOTS/.test(p.statuses[0].raw), "the PERM wording round-trips: " + JSON.stringify(p.statuses[0]));
  });

  await test("a permanent excuse and a dated one on the same start stay on separate lines", () => {
    const b = load(baseState({ medical: [
      perm(),
      perm({ id: "p2", status: "Excuse Camo", permanent: false, endDate: "30 Nov 2026" })
    ] }));
    const st = section(b.generateParadeStateText("FP", DATE, "0700"), "STATUS");
    eq(st.claimed, 2);
    ok(st.lines.some(l => l.includes("PERM EXCUSE BOOTS")), "the PERM line");
    ok(st.lines.some(l => /61D EXCUSE CAMO/.test(l)), "the dated line: " + st.lines.join(" | "));
  });
};
