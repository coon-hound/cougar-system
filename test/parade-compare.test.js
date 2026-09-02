// Parade-state COMPARE engine tests (js/parade-compare.js): the parser must
// round-trip the real generator output losslessly (that property pins parser
// and generator together forever), degrade gracefully on foreign/hand-edited
// text, and the differ must report person-level events (moved, extended,
// returned) instead of positional/text noise. Also covers the LCS line diff
// and the sheet-row normalizer's coercion defenses.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

// helpers.js (date utils) + parade-compare.js (engine under test) + forms.js
// (the real generator, for the round-trip property) in one shared scope —
// same pattern as parade.test.js.
function loadBundle(state) {
  const sandbox = {
    STATE: state, console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  const src = ["js/helpers.js", "js/parade-compare.js", "js/forms.js"]
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n")
    + "\n;this.generateParadeStateText = generateParadeStateText;"
    + "this.parseParadeState = parseParadeState;"
    + "this.diffParadeStates = diffParadeStates;"
    + "this.diffLines = diffLines;"
    + "this.normalizeParadeSnapshotRow = normalizeParadeSnapshotRow;"
    + "this.compareSummaryText = compareSummaryText;";
  vm.runInContext(src, sandbox, { filename: "parade-compare-bundle.js" });
  return sandbox;
}

const DATE = "2026-07-11";

// A company slice exercising every parade section at once: away MC (ATTC),
// LD (MEDICAL STATUS), Pending (REPORT SICK), an upcoming appointment
// (MEDICAL APPT), active leave (OTHERS), plus a commander for the
// COMMANDERS strength line.
const richState = () => ({
  roster: [
    { id: "1401", role: "Recruit", name: "Alpha One" },
    { id: "1402", role: "Recruit", name: "Bravo Two" },
    { id: "1403", role: "Recruit", name: "Charlie Three" },
    { id: "2401", role: "Recruit", name: "Delta Four" },
    { id: "2402", role: "Recruit", name: "Echo Five" },
    { id: "2403", role: "Recruit", name: "Foxtrot Six" },
    { id: "0012", role: "Commander", rank: "3SG", name: "Golf Cmd" }
  ],
  medical: [
    { d4: "1402", status: "MC", reason: "Flu", startDate: "11 Jul 2026", endDate: "13 Jul 2026", inCamp: false, location: "" },
    { d4: "1403", status: "LD", reason: "Ankle", startDate: "10 Jul 2026", endDate: "14 Jul 2026", location: "" },
    { d4: "2401", status: "Pending", reason: "Fever", startDate: "11 Jul 2026", endDate: "", location: "" }
  ],
  leave: [
    { id: 1, d4: "2402", type: "Annual Leave", startDate: "10 Jul 2026", endDate: "12 Jul 2026", reason: "family" }
  ],
  appointments: [
    { id: 9001, d4: "2403", reason: "Dental review", date: "11 Jul 2026", time: "1400", location: "NDC", outOfCamp: false, resolved: false }
  ],
  attendance: [], customStatuses: []
});

module.exports = async function run() {
  suite("parade-compare: parser round-trips the real generator (lossless)");

  const rich = loadBundle(richState());
  const txtA = rich.generateParadeStateText("FP", DATE, "0730");
  const parsedA = rich.parseParadeState(txtA);

  await test("header: type, DDMMYY date, time", () => {
    eq(parsedA.header.type, "FP", "type FP");
    eq(parsedA.header.dateIso, DATE, "dateIso round-trips");
    eq(parsedA.header.time, "0730", "time round-trips");
  });

  await test("strength block round-trips exactly", () => {
    eq(parsedA.strength.total, 7, "TOTAL 7");
    eq(parsedA.strength.current, 5, "CURRENT 5 (1402 MC + 2402 leave away)");
    eq(parsedA.strength.platoons["1"].in, 2, "P1 in");
    eq(parsedA.strength.platoons["1"].total, 3, "P1 total");
    eq(parsedA.strength.platoons["2"].in, 2, "P2 in");
    eq(parsedA.strength.commanders.in, 1, "CDR in");
    eq(parsedA.strength.commanders.total, 1, "CDR total");
  });

  await test("every person lands in the right section with a d4 key", () => {
    const by = {};
    parsedA.people.forEach(p => { by[p.key] = by[p.key] || []; by[p.key].push(p.section); });
    eq(String(by["d4:1402"]), "ATTC", "away MC → ATTC");
    eq(String(by["d4:2401"]), "REPORT_SICK", "Pending → REPORT SICK");
    eq(String(by["d4:1403"]), "MEDICAL_STATUS", "LD → MEDICAL STATUS");
    eq(String(by["d4:2403"]), "MEDICAL_APPT", "appointment → MEDICAL APPT");
    eq(String(by["d4:2402"]), "OTHERS", "leave → OTHERS");
    eq(parsedA.people.length, 5, "exactly 5 person entries (empty skeletons never count)");
  });

  await test("status label + duration parse into family/days/ISO range", () => {
    const mc = parsedA.people.find(p => p.key === "d4:1402");
    eq(mc.statuses.length, 1, "one status");
    eq(mc.statuses[0].family, "MC", "family MC");
    eq(mc.statuses[0].days, 3, "3D");
    eq(mc.statuses[0].startIso, "2026-07-11", "start ISO");
    eq(mc.statuses[0].endIso, "2026-07-13", "end ISO");
    eq(mc.reason, "Flu", "reason");
  });

  await test("lossless: zero unparsed lines, zero warnings, confidence ours", () => {
    eq(parsedA.unparsed.length, 0, "unparsed: " + JSON.stringify(parsedA.unparsed));
    eq(parsedA.warnings.length, 0, "warnings: " + JSON.stringify(parsedA.warnings));
    eq(parsedA.confidence, "ours", "confidence");
  });

  await test("consume-in-camp MC parses with inCamp flag", () => {
    const st = richState();
    st.medical[0].inCamp = true;   // 1402 now consumes the MC in camp
    const bundle = loadBundle(st);
    const parsed = bundle.parseParadeState(bundle.generateParadeStateText("FP", DATE, "0730"));
    const mc = parsed.people.find(p => p.key === "d4:1402");
    eq(mc.section, "MEDICAL_STATUS", "kept-in-camp MC lives under MEDICAL STATUS");
    ok(mc.statuses[0].inCamp === true, "inCamp suffix detected");
  });

  await test("an MC extended by a second record parses as one MC run", () => {
    // The extension is a SEPARATE record picking up the day after the first
    // ends. The report must state the run's real end, and the parser must keep
    // the family as plain "MC" so it diffs against yesterday's MC as the same
    // status rather than removed + added.
    const st = richState();
    st.medical.push({ d4: "1402", status: "MC", reason: "Flu", startDate: "14 Jul 2026", endDate: "16 Jul 2026", inCamp: false, location: "" });
    const bundle = loadBundle(st);
    const txt = bundle.generateParadeStateText("FP", DATE, "0730");
    const parsed = bundle.parseParadeState(txt);
    const mc = parsed.people.find(p => p.key === "d4:1402");
    eq(mc.statuses.length, 1, "one merged status, not two");
    eq(mc.statuses[0].family, "MC", "family is still MC");
    eq(mc.statuses[0].days, 6, "6D across both records");
    eq(mc.statuses[0].endIso, "2026-07-16", "ends at the extension, not 13 Jul");
    ok(mc.statuses[0].extended === true, "flagged extended");
    eq(parsed.unparsed.length, 0, "still lossless: " + JSON.stringify(parsed.unparsed));
    eq(parsed.warnings.length, 0, "no warnings: " + JSON.stringify(parsed.warnings));
  });

  suite("parade-compare: differ reports person-level events");

  // Overnight changes: 2401's Pending became a real away MC (the classic
  // escalation), 1402's MC was extended 2 days, 1403's reason was corrected,
  // and 2402 returned from leave.
  const stB = richState();
  stB.medical = [
    { d4: "1402", status: "MC", reason: "Flu", startDate: "11 Jul 2026", endDate: "15 Jul 2026", inCamp: false, location: "" },
    { d4: "1403", status: "LD", reason: "Knee", startDate: "10 Jul 2026", endDate: "14 Jul 2026", location: "" },
    { d4: "2401", status: "MC", reason: "Fever", startDate: "11 Jul 2026", endDate: "12 Jul 2026", inCamp: false, location: "" }
  ];
  stB.leave = [];
  const bundleB = loadBundle(stB);
  const txtB = bundleB.generateParadeStateText("LP", DATE, "1800");
  const diffAB = rich.diffParadeStates(rich.parseParadeState(txtA), rich.parseParadeState(txtB), { oldText: txtA, newText: txtB });

  await test("Pending → MC is ONE moved change, never an out+in pair", () => {
    ok(!diffAB.people.added.some(a => a.entry.key === "d4:2401"), "2401 not in added");
    ok(!diffAB.people.removed.some(r => r.entry.key === "d4:2401"), "2401 not in removed");
    const chg = diffAB.people.changed.find(c => c.key === "d4:2401");
    ok(chg, "2401 is a changed entry");
    const moved = chg.changes.find(ch => ch.field === "section" && ch.kind === "moved");
    ok(moved && moved.old === "REPORT SICK" && moved.new === "ATTC", "moved REPORT SICK → ATTC");
  });

  await test("MC extension shows as extended (+2D), not added+removed", () => {
    const chg = diffAB.people.changed.find(c => c.key === "d4:1402");
    ok(chg, "1402 changed");
    const ext = chg.changes.find(ch => ch.field === "status" && ch.kind === "extended");
    ok(ext, "kind extended");
    eq(ext.note, "+2D", "note +2D");
  });

  await test("reason edit + leave return are reported", () => {
    const chg = diffAB.people.changed.find(c => c.key === "d4:1403");
    ok(chg && chg.changes.some(ch => ch.field === "reason" && ch.new === "Knee"), "1403 reason Ankle → Knee");
    const ret = diffAB.people.removed.find(r => r.entry.key === "d4:2402");
    ok(ret, "2402 no longer listed");
    eq(ret.direction, "in", "OTHERS removal = back in camp");
    // The 1400 appointment correctly drops off the 1800 LP (time cutoff) and
    // is reported as done — an "info" removal, not a strength movement.
    const appt = diffAB.people.removed.find(r => r.entry.key === "d4:2403");
    ok(appt, "2403 appointment no longer listed");
    eq(appt.direction, "info", "MEDICAL APPT removal is informational");
  });

  await test("strength deltas + movement reconcile (no warning)", () => {
    eq(diffAB.strength.current.delta, 0, "CURRENT 5 → 5 (one out, one back)");
    ok(!diffAB.warnings.some(w => /reconcile/.test(w)), "no reconcile warning: " + JSON.stringify(diffAB.warnings));
    ok(diffAB.structuredOk, "structured view ok");
  });

  await test("hand-edited strength line triggers the reconcile note", () => {
    const mangled = txtB.replace("CURRENT STRENGTH: 5", "CURRENT STRENGTH: 3");
    const d = rich.diffParadeStates(rich.parseParadeState(txtA), rich.parseParadeState(mangled), {});
    ok(d.warnings.some(w => /reconcile|imply/.test(w)), "warning present: " + JSON.stringify(d.warnings));
  });

  await test("self-diff and appended 'latest version as of' line are no-ops", () => {
    const d1 = rich.diffParadeStates(rich.parseParadeState(txtA), rich.parseParadeState(txtA), {});
    eq(d1.people.added.length + d1.people.removed.length + d1.people.changed.length, 0, "self-diff clean");
    ok(d1.people.unchangedCount >= 5, "entries counted as unchanged");
    const resent = txtA + "\nlatest version as of 110726 @ 0745 Hrs";
    const d2 = rich.diffParadeStates(rich.parseParadeState(txtA), rich.parseParadeState(resent), {});
    eq(d2.people.added.length + d2.people.removed.length + d2.people.changed.length, 0, "re-send note adds no person diffs");
  });

  suite("parade-compare: multiple entries per (person, section)");

  // Our own generator emits ONE MEDICAL APPT block per appointment, so a
  // recruit with two upcoming appointments appears twice in one section —
  // the differ must never collapse them (a resolved appointment would vanish
  // from the diff; a newly booked one would read as a phantom edit).
  const apptState = extra => {
    const st = richState();
    st.medical = []; st.leave = [];
    st.appointments = [
      { id: 9001, d4: "2403", reason: "Dental review", date: "12 Jul 2026", time: "1400", location: "NDC", outOfCamp: false, resolved: false }
    ].concat(extra || []);
    return st;
  };
  const apptText = st => { const b = loadBundle(st); return b.generateParadeStateText("FP", DATE, "0730"); };
  const ortho = { id: 9002, d4: "2403", reason: "Ortho specialist", date: "20 Jul 2026", time: "0900", location: "SGH", outOfCamp: false, resolved: false };

  await test("resolved appointment is reported as removed, not swallowed", () => {
    const d = rich.diffParadeStates(
      rich.parseParadeState(apptText(apptState([ortho]))),   // dental + ortho
      rich.parseParadeState(apptText(apptState())), {});     // dental only
    const rem = d.people.removed.find(r => r.entry.key === "d4:2403");
    ok(rem, "ortho appointment reported as removed");
    ok(/Ortho/.test(rem.entry.reason), "the RIGHT appointment was removed: " + rem.entry.reason);
    eq(d.people.changed.length, 0, "no phantom edits");
  });

  await test("newly booked second appointment is added, not a phantom edit", () => {
    const d = rich.diffParadeStates(
      rich.parseParadeState(apptText(apptState())),           // dental only
      rich.parseParadeState(apptText(apptState([ortho]))), {}); // dental + ortho
    const add = d.people.added.find(a => a.entry.key === "d4:2403");
    ok(add && /Ortho/.test(add.entry.reason), "ortho reported as added");
    eq(d.people.changed.length, 0, "dental appointment not misread as edited");
  });

  await test("a single rescheduled appointment still reads as a date edit", () => {
    const moved = apptState();
    moved.appointments[0].date = "15 Jul 2026";
    const d = rich.diffParadeStates(
      rich.parseParadeState(apptText(apptState())),
      rich.parseParadeState(apptText(moved)), {});
    eq(d.people.added.length + d.people.removed.length, 0, "not an out+in pair");
    const chg = d.people.changed.find(c => c.key === "d4:2403");
    ok(chg && chg.changes.some(ch => ch.field === "date"), "date change reported");
  });

  suite("parade-compare: foreign / partial formats");

  const FOREIGN = [
    "BRAVO COY",
    "FIRST PARADE STATE",
    "DATE: 110726 @ 0800HRS",
    "",
    "TOTAL: 100",
    "CURRENT: 97/100",
    "",
    "RSO: 2",
    "1. PTE JOHN LIM 2345",
    "Reason: fever",
    "2. rec tan ah kow C1234",
    "",
    "OTHERS:",
    "R/N: 3SG BENG HUAT",
    "Reason: course"
  ].join("\n");

  await test("foreign text: sections, ids and strength extracted best-effort", () => {
    const p = rich.parseParadeState(FOREIGN);
    eq(p.header.type, "FP", "type");
    eq(p.header.dateIso, "2026-07-11", "date");
    eq(p.strength.total, 100, "TOTAL: 100");
    eq(p.strength.current, 97, "combined CURRENT: 97/100");
    const keys = p.people.map(x => x.key).sort();
    ok(keys.includes("d4:2345") && keys.includes("d4:1234"), "numbered entries keyed by 4D: " + keys);
    ok(keys.includes("nm:BENG HUAT"), "commander keyed by rank-stripped name: " + keys);
    eq(p.people.find(x => x.key === "d4:2345").section, "REPORT_SICK", "RSO → REPORT SICK");
  });

  await test("rank change alone does not change the person key", () => {
    const a = rich.parseParadeState("OTHERS:\nR/N: 3SG BENG HUAT\nReason: course");
    const b = rich.parseParadeState("OTHERS:\nR/N: 2SG BENG HUAT\nReason: course");
    const d = rich.diffParadeStates(a, b, {});
    eq(d.people.added.length + d.people.removed.length + d.people.changed.length, 0, "promotion is a no-op");
  });

  await test("MED-only list vs full FP: only shared sections compared", () => {
    const medOnly = "110726(latest version as of 110726 @0730 Hrs)\n\n" +
      "MEDICAL STATUS: 01\n\nS/N: 01\nR/N: REC CHARLIE THREE C1403\nReason: Ankle\nStatus: 5D LD\nDuration: 100726 - 140726";
    const d = rich.diffParadeStates(rich.parseParadeState(medOnly), parsedA, {});
    ok(!d.people.removed.length && !d.people.added.some(a => a.entry.section !== "MEDICAL_STATUS"),
      "ATTC/OTHERS people never reported against a MED-only base");
    ok(d.warnings.some(w => /skipped/.test(w)), "skip warning present");
  });

  await test("garbage paste fails the structured gate", () => {
    const d = rich.diffParadeStates(rich.parseParadeState("hello there\ngeneral kenobi"), parsedA, {});
    ok(!d.structuredOk, "structuredOk false");
  });

  suite("parade-compare: LCS line diff");

  await test("classic add/del/same", () => {
    const d = rich.diffLines(["a", "b", "c"], ["a", "c", "d"]);
    eq(JSON.stringify(d), JSON.stringify([
      { type: "same", line: "a" }, { type: "del", line: "b" },
      { type: "same", line: "c" }, { type: "add", line: "d" }
    ]), "diff ops");
    ok(rich.diffLines(["x"], ["x"]).every(l => l.type === "same"), "identical → all same");
  });

  suite("parade-compare: snapshot row normalization (Sheets coercion)");

  await test("JSON-cell row round-trips; coerced legacy columns are repaired", () => {
    const good = rich.normalizeParadeSnapshotRow({
      id: "ps-1", type: "FP", savedAt: 1783150000000,
      json: JSON.stringify({ dateIso: "2026-07-11", time: "0700", text: "COUGAR COMPANY\n\"quotes\" & emoji 🦵" })
    });
    eq(good.dateIso, "2026-07-11", "dateIso");
    eq(good.time, "0700", "time");
    ok(good.text.includes("🦵"), "emoji + quotes survive");
    // Legacy/hand-made row: Sheets turned the date cell into a display date
    // and the time into a bare number.
    const legacy = rich.normalizeParadeSnapshotRow({ id: "ps-2", type: "LP", savedAt: "1783150000001", dateIso: "11 Jul 2026", time: 700, text: "X" });
    eq(legacy.dateIso, "2026-07-11", "display date repaired to ISO");
    eq(legacy.time, "0700", "time zero-padded");
    eq(legacy.savedAt, 1783150000001, "savedAt numeric");
    ok(rich.normalizeParadeSnapshotRow({ id: "", text: "x" }) === null, "rows without id are dropped");
    // JSON.parse("null") succeeds — the normalizer must not throw on it.
    ok(rich.normalizeParadeSnapshotRow({ id: "ps-3", json: "null", text: "T" }) !== undefined, "json:'null' does not throw");
  });

  suite("parade-compare: WhatsApp change summary");

  await test("summary text carries the headline groups", () => {
    const txt = rich.compareSummaryText(diffAB, "FP 110726 0730", "LP 110726 1800");
    ok(txt.includes("PARADE STATE CHANGES"), "title");
    ok(txt.includes("NO LONGER LISTED (2)"), "returned group (leave return + appt done): " + txt);
    ok(txt.includes("CHANGED (3)"), "changed group: " + txt);
    ok(/REPORT SICK -> ATTC/.test(txt), "section move line");
  });
};
