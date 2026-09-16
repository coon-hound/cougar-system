// Hospitalisation Leave: an MO-issued leave following treatment.
//
// The point of the status is that it is NOT an MC. The man is away from camp
// and counted away exactly like an MC, but he cannot come into camp to endorse
// anything, and the parade state has to say "HOSP LEAVE" rather than "MC" so
// HQ reads the right thing.
//
// These tests pin the two halves that can drift apart: the shared away-from-camp
// computation (outOfCampMap and everything that reads it) and the parade line.
// The spelling fold is pinned here too - the repo stores the British
// "Hospitalisation", and a record that arrives with the American "Hospitalization"
// must canonicalise rather than becoming an unknown custom status, which would
// quietly stop counting a man out of camp.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

// helpers.js + state.js + forms.js in one scope, the way index.html loads them.
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
  // state.js declares its own top-level `const STATE`, which shadows the
  // sandbox global exactly as it does in the browser - so the fixture is
  // assigned INTO that object after load, not passed in around it.
  const src = ["js/helpers.js", "js/state.js", "js/parade-compare.js", "js/forms.js"]
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n")
    + "\n;this.generateParadeStateText = generateParadeStateText;"
    + "this.parseParadeState = parseParadeState;"
    + "this.outOfCampMap = outOfCampMap;"
    + "this.derivedCampOut = derivedCampOut;"
    + "this.normalizeMedical = normalizeMedical;"
    + "this.canonMedStatus = canonMedStatus;"
    + "this.isAwayMedStatus = isAwayMedStatus;"
    + "this.statusParticipates = statusParticipates;"
    + "this.medSeverityRank = medSeverityRank;"
    + "this.medStatusRun = medStatusRun;"
    + "this.medTagBadge = medTagBadge;"
    + "this.MED_STATUSES = MED_STATUSES;"
    + "this.MED_HOSP_LEAVE = MED_HOSP_LEAVE;"
    + "this.currentMedicalEffectiveAll = currentMedicalEffectiveAll;"
    + "this.findBorderlineReturnees = findBorderlineReturnees;"
    + "this.tickBorderline = d4 => { _paradeOverrides[d4] = true; };"
    + "this.clearBorderline = () => { _paradeOverrides = {}; };"
    + "this.__setState = s => { Object.keys(STATE).forEach(k => { delete STATE[k]; }); Object.assign(STATE, s); return STATE; };";
  vm.runInContext(src, sandbox, { filename: "hosp-leave-bundle.js" });
  sandbox.STATE = sandbox.__setState(state);
  return sandbox;
}

const DATE = "2026-09-01";
const HOSP = "Hospitalisation Leave";

// The invented roll (docs/nominal-roll-template.csv shapes); never a real name.
const baseState = extra => Object.assign({
  roster: [
    { id: "1101", role: "Recruit", rank: "PTE", name: "Tan Wei Ming" },
    { id: "1102", role: "Recruit", rank: "PTE", name: "Lim Jun Wei" },
    { id: "1103", role: "Recruit", rank: "PTE", name: "Chua Kai Xin" }
  ],
  medical: [], leave: [], appointments: [], attendance: [], customStatuses: [], msk: []
}, extra || {});

// Every record line filed under one section header, across all blocks. COY HQ
// files its own empty "ATT C: 0" before the platoon's, so a plain search for
// the first header finds the wrong one.
function section(text, label) {
  const head = new RegExp("^" + label.replace("/", "\\/") + ": (\\d+)$");
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

const hospRecord = over => Object.assign({
  id: "m1", d4: "1102", status: HOSP, reason: "Post-op",
  startDate: "01 Sep 2026", endDate: "14 Sep 2026", inCamp: false, location: ""
}, over || {});

module.exports = async function run() {

  suite("hospitalisation leave: it is a selectable medical status");

  await test("it is in MED_STATUSES, grouped with the away-from-camp statuses", () => {
    const b = load(baseState());
    ok(b.MED_STATUSES.indexOf(HOSP) >= 0, "selectable wherever MED_STATUSES drives a dropdown");
    eq(b.MED_HOSP_LEAVE, HOSP, "the canonical stored value is the British spelling");
    ok(b.isAwayMedStatus(HOSP), "it is an away-from-camp status");
    ok(b.isAwayMedStatus("MC"), "MC still is too");
    ok(!b.isAwayMedStatus("LD"), "LD is not");
  });

  suite("hospitalisation leave: the spelling fold");

  await test("normalizeMedical rewrites the American spelling to the stored one", () => {
    const b = load(baseState());
    const out = b.normalizeMedical([hospRecord({ status: "Hospitalization Leave" })]);
    eq(out[0].status, HOSP, "stored as Hospitalisation Leave");
  });

  await test("canonMedStatus tolerates casing and stray whitespace", () => {
    const b = load(baseState());
    ["Hospitalization Leave", "  hospitalisation leave  ", "HOSPITALIZATION LEAVE"]
      .forEach(v => eq(b.canonMedStatus(v), HOSP, "folds " + JSON.stringify(v)));
    eq(b.canonMedStatus("MC"), "MC", "everything else passes through");
  });

  await test("a record stored with the OTHER spelling still counts the man out of camp", () => {
    // The belt-and-braces case: a row that somehow skipped the normalizer.
    const b = load(baseState({ medical: [hospRecord({ status: "Hospitalization Leave" })] }));
    ok(b.outOfCampMap(DATE).has("1102"), "still out of camp");
    const text = b.generateParadeStateText("FP", DATE, "0700");
    ok(/HOSP LEAVE/.test(text), "and still prints as HOSP LEAVE: " + text);
    ok(!/HOSPITALIZATION/i.test(text), "never the raw stored spelling");
  });

  suite("hospitalisation leave: counted away, exactly like an MC");

  await test("outOfCampMap and derivedCampOut file it as medical, out until the end date", () => {
    const b = load(baseState({ medical: [hospRecord()] }));
    const info = b.outOfCampMap(DATE).get("1102");
    ok(info, "in the out-of-camp map");
    eq(info.kind, "medical", "filed as medical, not leave");
    eq(info.until, "2026-09-14", "out until the last day");
    eq(info.back, "2026-09-15", "back the next day");
    eq(b.derivedCampOut("1102", DATE).kind, "medical", "derivedCampOut agrees");
  });

  await test("it is not participating, and ranks as severe as an MC", () => {
    const b = load(baseState());
    ok(!b.statusParticipates(HOSP), "does not participate in conducts");
    eq(b.medSeverityRank(HOSP), b.medSeverityRank("MC"), "same severity tier as MC");
  });

  await test("back-to-back re-issues merge into one run, like an extended MC", () => {
    const b = load(baseState({
      medical: [
        hospRecord({ id: "m1", startDate: "01 Sep 2026", endDate: "07 Sep 2026" }),
        hospRecord({ id: "m2", startDate: "08 Sep 2026", endDate: "14 Sep 2026" })
      ]
    }));
    const run = b.medStatusRun(b.STATE.medical[0]);
    ok(run.chained, "the two records are one run");
    eq(run.startIso, "2026-09-01", "run starts at the first record");
    eq(run.endIso, "2026-09-14", "run ends at the second");
    eq(run.days, 14, "14 days across the whole run");
    eq(b.outOfCampMap(DATE).get("1102").until, "2026-09-14", "out until the END of the run");
  });

  await test("a hosp leave never merges with an MC - they are different classifications", () => {
    const b = load(baseState({
      medical: [
        hospRecord({ id: "m1", startDate: "01 Sep 2026", endDate: "07 Sep 2026" }),
        { id: "m2", d4: "1102", status: "MC", reason: "Flu", startDate: "08 Sep 2026", endDate: "10 Sep 2026", inCamp: false, location: "" }
      ]
    }));
    ok(!b.medStatusRun(b.STATE.medical[0]).chained, "different families do not chain");
    const tags = b.currentMedicalEffectiveAll(DATE)[0].statuses.map(s => s.tag);
    eq(tags.join(","), HOSP, "only the hosp leave is active on the 1st");
  });

  await test("the badge shows the phone-width shorthand, not the full name", () => {
    const b = load(baseState());
    ok(/Hosp Leave/.test(b.medTagBadge(HOSP)), "badge reads Hosp Leave: " + b.medTagBadge(HOSP));
    ok(!/Hospitalisation/.test(b.medTagBadge(HOSP)), "the full name never fits a badge");
  });

  suite("hospitalisation leave: the parade line");

  await test("it files under ATT C as its OWN classification, alongside MC", () => {
    const b = load(baseState({
      medical: [
        { id: "m0", d4: "1101", status: "MC", reason: "Conjunctivitis", startDate: "01 Sep 2026", endDate: "04 Sep 2026", inCamp: false, location: "" },
        hospRecord()
      ]
    }));
    const text = b.generateParadeStateText("FP", DATE, "0700");
    const attc = section(text, "ATT C");
    eq(attc.claimed, 2, "both records are claimed by ATT C: " + text);
    eq(attc.lines[0], "1. 1101 PTE TAN WEI MING - 4D MC (Conjunctivitis) (010926-040926)", "the MC line is unchanged");
    eq(attc.lines[1], "2. 1102 PTE LIM JUN WEI - 14D HOSP LEAVE (Post-op) (010926-140926)", "the hosp leave line");
    eq(section(text, "OFF/LEAVE").claimed, 0, "it is not duplicated under OFF/LEAVE");
    eq(section(text, "STATUS").claimed, 0, "and it never falls into the STATUS catch-all");
  });

  await test("the strength counts the man away, and the parser reads the line back", () => {
    const b = load(baseState({ medical: [hospRecord()] }));
    const text = b.generateParadeStateText("FP", DATE, "0700");
    ok(/^COMPANY: 2\/3$/m.test(text), "one of three is away: " + text);
    const parsed = b.parseParadeState(text);
    eq(parsed.unparsed.length, 0, "nothing unparsed: " + JSON.stringify(parsed.unparsed));
    eq(parsed.warnings.length, 0, "no warnings: " + JSON.stringify(parsed.warnings));
    eq(parsed.confidence, "ours", "recognised as our own format");
    const p = parsed.people.find(x => x.d4 === "1102");
    ok(p, "the man is in the parsed state");
    eq(p.section, "ATTC", "parsed under ATT C");
    eq(p.statuses[0].family, "HOSP LEAVE", "its own family, NOT MC");
    eq(p.statuses[0].days, 14, "day count round-trips");
    eq(p.statuses[0].startIso, "2026-09-01", "start date round-trips");
    eq(p.statuses[0].endIso, "2026-09-14", "end date round-trips");
    eq(p.reason, "Post-op", "reason round-trips");
  });

  await test("free text in the reason cannot break the line", () => {
    const b = load(baseState({ medical: [hospRecord({ reason: "Post-op (day 3)\nreview @ TTSH" })] }));
    const text = b.generateParadeStateText("FP", DATE, "0700");
    const recs = text.split("\n").filter(l => /^\d+\. /.test(l));
    eq(recs.length, 1, "still exactly one record line: " + JSON.stringify(recs));
    const parsed = b.parseParadeState(text);
    eq(parsed.unparsed.length, 0, "nothing unparsed");
    eq(parsed.people[0].reason, "Post-op day 3 review at TTSH", "brackets and @ neutralised");
  });

  await test("a returnee the PDS ticks reads RETURNING FROM HOSP LEAVE, not FROM MC", () => {
    const b = load(baseState({ medical: [hospRecord({ startDate: "20 Aug 2026", endDate: "31 Aug 2026" })] }));
    const cands = b.findBorderlineReturnees(DATE);
    eq(cands.length, 1, "a hosp leave that ended yesterday is offered as a borderline returnee");
    b.tickBorderline("1102");
    const text = b.generateParadeStateText("FP", DATE, "0700");
    ok(/RETURNING FROM HOSP LEAVE/.test(text), "OTHERS names the right status: " + text);
    ok(!/RETURNING FROM MC/.test(text), "not mislabelled as an MC");
    ok(/^COMPANY: 2\/3$/m.test(text), "and the ticked returnee still counts away");
    b.clearBorderline();
  });

  await test("a LEGACY leave row typed as hospitalisation leave files under ATT C too", () => {
    // It used to be a leave TYPE (it was in PARADE_OFF_LEAVE_TYPES before this
    // status existed). One real-world thing has to land in one section, whichever
    // layer a commander happened to log it in.
    const b = load(baseState({
      leave: [{ id: "l1", d4: "1103", type: HOSP, reason: "Post-op", startDate: "01 Sep 2026", endDate: "05 Sep 2026" }]
    }));
    const text = b.generateParadeStateText("FP", DATE, "0700");
    const attc = section(text, "ATT C");
    eq(attc.claimed, 1, "filed under ATT C: " + text);
    eq(attc.lines[0], "1. 1103 PTE CHUA KAI XIN - HOSP LEAVE (Post-op) (010926-050926)",
      "with the same wording as the medical status");
    eq(section(text, "OFF/LEAVE").claimed, 0, "and NOT under OFF/LEAVE");
  });
};
