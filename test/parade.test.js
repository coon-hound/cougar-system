// Parade-state generation tests (js/forms.js) against the 40 SAR battalion
// format: one block per sub-unit, six fixed sections, one line per record.
// Covers the placement rules that decide whether a body counts as present —
// the consume-in-camp MC, a person who is out for several reasons at once,
// and the merged span of a re-issued status. helpers.js + forms.js are loaded
// together (the parade generators call helpers.js); no DOM is needed.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function loadParade(state) {
  const sandbox = {
    STATE: state, console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  const src = ["js/helpers.js", "js/forms.js"]
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n")
    + "\n;this.generateParadeStateText = generateParadeStateText;"
    // Expose the borderline-returnee override so tests can simulate the PDS
    // ticking a recently-ended MC as still-out.
    + "this.tickBorderline = d4 => { _paradeOverrides[d4] = true; };"
    // The other two rank-bearing reports. They are separate generators with
    // their own R/N formatters (paradeRN and a near-copy, rnNoC), so the parade
    // state agreeing with the roster says nothing about them.
    + "this.generateMedicalStatusText = generateMedicalStatusText;"
    + "this.generateMSKReportText = generateMSKReportText;";
  vm.runInContext(src, sandbox, { filename: "parade-bundle.js" });
  return sandbox;
}

const DATE = "2026-06-29";
const state = () => ({
  roster: [
    { id: "1303", role: "Recruit", name: "Shuan Aaron Tan Yong Sheng" },
    { id: "2201", role: "Recruit", name: "Away Guy" },
    { id: "3405", role: "Recruit", name: "LD Guy" }
  ],
  medical: [
    // consume-in-camp MC — still ATT C, but counted present (IN)
    { d4: "1303", status: "MC", reason: "Fever", startDate: "29 Jun 2026", endDate: "30 Jun 2026", inCamp: true, location: "" },
    // ordinary away MC
    { d4: "2201", status: "MC", reason: "Flu", startDate: "29 Jun 2026", endDate: "01 Jul 2026", inCamp: false, location: "" },
    // an LD, which belongs under STATUS rather than ATT C
    { d4: "3405", status: "LD", reason: "Ankle", startDate: "29 Jun 2026", endDate: "02 Jul 2026", location: "" }
  ],
  leave: [], appointments: [], attendance: [], customStatuses: []
});

// Every record line filed under one section header, across all blocks. A
// section runs from its "<LABEL>: <n>" header to the next header; the lines
// between are the numbered records.
function section(text, label) {
  const head = new RegExp("^" + label.replace("/", "\\/") + ": (\\d+)$");
  const lines = [];
  let inside = false;
  text.split("\n").forEach(l => {
    if (head.test(l)) { inside = true; return; }
    if (inside && /^\d+\. /.test(l)) { lines.push(l); return; }
    inside = false;
  });
  return lines.join("\n");
}

// The section's claimed count, summed over every block.
function sectionCount(text, label) {
  const head = new RegExp("^" + label.replace("/", "\\/") + ": (\\d+)$");
  return text.split("\n").reduce((n, l) => {
    const m = head.exec(l);
    return m ? n + +m[1] : n;
  }, 0);
}

module.exports = async function run() {
  suite("parade: 40 SAR format skeleton");

  const txt = loadParade(state()).generateParadeStateText("FP", DATE, "0730");

  await test("header, command team and block order follow the template", () => {
    const lines = txt.split("\n");
    eq(lines[0], "40 SAR COUGAR COMPANY", "company line");
    eq(lines[1], "FIRST PARADE STATE", "report type");
    eq(lines[2], "DATE: 290626 TIME: 0730", "date + time line");
    // No duty roster in this harness → every appointment is a placeholder.
    ok(/^CDO: <RANK> <NAME>$/m.test(txt), "CDO line");
    ok(/^PDS 1: <RANK> <NAME>$/m.test(txt), "a PDS line per platoon");
    ok(txt.indexOf("COY HQ:") < txt.indexOf("PL 1:"), "COY HQ is filed first");
    ok(txt.indexOf("PL 1:") < txt.indexOf("PL 2:") && txt.indexOf("PL 2:") < txt.indexOf("PL 3:"), "platoons ascend");
  });

  await test("every block carries all six sections, in order, never blank", () => {
    const blocks = txt.split("\n" + "-".repeat(32) + "\n");
    eq(blocks.length, 4, "COY HQ + PL 1 + PL 2 + PL 3");
    blocks.forEach(b => {
      const headers = b.split("\n").map(l => /^([A-Z][A-Z /]*): \d+$/.exec(l)).filter(Boolean).map(m => m[1]);
      eq(String(headers), "ATT C,STATUS,REPORT SICK,MA,OFF/LEAVE,OTHERS", "six fixed section names in order");
    });
  });

  await test("strength lines add up: blocks to COMPANY, ranks to their block", () => {
    // 3 recruits, only the away MC (1201) is out → COMPANY 2/3.
    ok(/^COMPANY: 2\/3$/m.test(txt), "company present/strength: " + txt.split("\n")[9]);
    ok(/^COY HQ: 0\/0$/m.test(txt), "no commanders in this roster");
    ok(/^PL 1: 1\/1$/m.test(txt), "PL 1 (1303) present");
    ok(/^PL 2: 0\/1$/m.test(txt), "PL 2 (2201) away on MC");
    ok(/^PL 3: 1\/1$/m.test(txt), "PL 3 (3405) present");
    // The three rank lines under COMPANY must sum to the company strength.
    const [officer, wospec, enlistee] = txt.split("\n").slice(txt.split("\n").indexOf("COMPANY: 2/3") + 1, txt.split("\n").indexOf("COMPANY: 2/3") + 4);
    eq(officer, "OFFICER: 0/0", "officers");
    eq(wospec, "WOSPEC: 0/0", "wospecs");
    eq(enlistee, "ENLISTEE: 2/3", "enlistees carry the whole company");
  });

  suite("parade: consume-in-camp MC stays under ATT C, marked IN");

  await test("an in-camp MC is counted present but still listed", () => {
    const attc = section(txt, "ATT C");
    ok(/^1\. 1303 REC SHUAN AARON TAN YONG SHENG - 2D MC \(Fever\) \(290626-300626\) IN$/m.test(attc), "in-camp MC line: " + attc);
    ok(/2201 REC AWAY GUY - 3D MC \(Flu\) \(290626-010726\)$/m.test(attc), "away MC carries no marker: " + attc);
    eq(sectionCount(txt, "ATT C"), 2, "both MCs are listed");
  });

  await test("an LD files under STATUS, never ATT C", () => {
    const status = section(txt, "STATUS");
    ok(/3405 REC LD GUY - 4D LD \(Ankle\)/.test(status), "LD under STATUS: " + status);
    ok(!/3405/.test(section(txt, "ATT C")), "LD is not an ATT C entry");
    eq(sectionCount(txt, "STATUS"), 1, "one STATUS entry");
  });

  suite("parade: one body, one absence — no double counting");

  await test("active away MC + accidental book-out + leave is still one line", () => {
    // 2201 is genuinely away on MC AND was accidentally booked out AND put on
    // leave. outOfCampMap's medical precedence must keep the duplicates out.
    const st = state();
    const r = st.roster.find(x => x.id === "2201");
    r.outOfCamp = true; r.outSince = DATE;
    st.leave.push({ id: 1, d4: "2201", type: "Annual Leave", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "accidental" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/2201/.test(section(out, "ATT C")), "on MC → ATT C");
    ok(!/2201/.test(section(out, "OTHERS")), "accidental book-out suppressed from OTHERS");
    // ATT C and OFF/LEAVE both say "out of camp", so the leave must not list
    // them a second time — the MC is the reason they are away.
    ok(!/2201/.test(section(out, "OFF/LEAVE")), "leave not listed alongside ATT C: " + section(out, "OFF/LEAVE"));
    ok(/^COMPANY: 2\/3$/m.test(out), "still one body away: " + out);
  });

  await test("a STATUS holder on OFF is listed under STATUS and OFF/LEAVE", () => {
    // STATUS says nothing about where someone is, so it stacks with an absence.
    const st = state();
    st.leave.push({ id: 5, d4: "3405", type: "Off-in-Lieu", startDate: "29 Jun 2026", endDate: "29 Jun 2026", reason: "" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/3405 REC LD GUY - 4D LD \(Ankle\) \(290626-020726\) OUT/.test(section(out, "STATUS")), "LD still under STATUS, marked OUT: " + section(out, "STATUS"));
    ok(/3405 REC LD GUY - OFF-IN-LIEU \(290626\)/.test(section(out, "OFF/LEAVE")), "OFF under OFF/LEAVE: " + section(out, "OFF/LEAVE"));
    ok(/^COMPANY: 1\/3$/m.test(out), "counted away once: " + out);
  });

  await test("a report sick or appointment on OFF keeps both lines", () => {
    const st = state();
    st.medical.push({ d4: "1303", status: "Pending", reason: "Cough", startDate: "29 Jun 2026", location: "" });
    st.appointments.push({ id: 32, d4: "3405", reason: "Dental", date: "30 Jun 2026", time: "0900", location: "", outOfCamp: false, resolved: false });
    st.leave.push(
      { id: 6, d4: "1303", type: "Off-in-Lieu", startDate: "29 Jun 2026", endDate: "29 Jun 2026", reason: "" },
      { id: 7, d4: "3405", type: "Weekend", startDate: "29 Jun 2026", endDate: "29 Jun 2026", reason: "" }
    );
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/1303/.test(section(out, "REPORT SICK")) && /1303/.test(section(out, "OFF/LEAVE")), "report sick + OFF: " + out);
    ok(/3405/.test(section(out, "MA")) && /3405/.test(section(out, "OFF/LEAVE")), "MA + weekend: " + out);
  });

  await test("only one out-of-camp section per person: ATT C > OFF/LEAVE > OTHERS", () => {
    const st = state();
    // 2201: away MC + a course → ATT C only.
    st.leave.push({ id: 8, d4: "2201", type: "Course", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "" });
    // 3405: OFF + guard duty + a manual book-out → OFF/LEAVE only.
    st.leave.push(
      { id: 9, d4: "3405", type: "Off-in-Lieu", startDate: "29 Jun 2026", endDate: "29 Jun 2026", reason: "" },
      { id: 10, d4: "3405", type: "Guard Duty", startDate: "29 Jun 2026", endDate: "29 Jun 2026", reason: "" }
    );
    Object.assign(st.roster.find(x => x.id === "3405"), { outOfCamp: true, outSince: DATE, outReason: "Errand" });
    // 2201 is warded as well → the ATT C MC wins over the OTHERS Warded too.
    st.medical.push({ d4: "2201", status: "Warded", reason: "Dengue", startDate: "29 Jun 2026", endDate: "30 Jun 2026", location: "" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/2201/.test(section(out, "ATT C")) && !/2201/.test(section(out, "OTHERS")), "MC beats course: " + out);
    ok(/3405/.test(section(out, "OFF/LEAVE")) && !/3405/.test(section(out, "OTHERS")), "OFF beats guard duty + book-out: " + out);
    ok(/3405/.test(section(out, "STATUS")), "LD still listed under STATUS");
  });

  await test("a consume-in-camp MC never hides a real absence", () => {
    // 1303's MC is consumed in camp, so its ATT C line doesn't say they are out;
    // the OFF they also hold is the absence, and both lines stay.
    const st = state();
    st.leave.push({ id: 11, d4: "1303", type: "Off-in-Lieu", startDate: "29 Jun 2026", endDate: "29 Jun 2026", reason: "" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/1303/.test(section(out, "ATT C")), "MC still listed: " + section(out, "ATT C"));
    ok(/1303/.test(section(out, "OFF/LEAVE")), "OFF still listed: " + section(out, "OFF/LEAVE"));
  });

  await test("borderline returnee (MC ended yesterday, ticked) is filed once", () => {
    // 1201's MC ended the day before DATE, so it is INACTIVE — the PDS ticks
    // them still-out. They also have leave today, which must not double-file
    // them now that medical precedence no longer applies.
    const st = state();
    st.medical.find(m => m.d4 === "2201").endDate = "28 Jun 2026"; // ended yesterday
    st.leave.push({ id: 2, d4: "2201", type: "Annual Leave", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "x" });
    const bundle = loadParade(st);
    bundle.tickBorderline("2201");
    const out = bundle.generateParadeStateText("FP", DATE, "0730");
    const others = section(out, "OTHERS");
    ok(/2201 REC AWAY GUY - RETURNING FROM MC/.test(others), "returning from MC files under OTHERS: " + others);
    ok(!/2201/.test(section(out, "ATT C")), "the ended MC is no longer an ATT C entry");
    ok(!/2201/.test(section(out, "OFF/LEAVE")), "not double-filed under OFF/LEAVE: " + section(out, "OFF/LEAVE"));
    ok(/^COMPANY: 2\/3$/m.test(out), "ticked returnee counts away: " + out);
  });

  await test("an out-of-camp appointment is filed under MA, not twice", () => {
    const st = state();
    st.appointments.push({ id: 31, d4: "3405", reason: "Physio", date: "29 Jun 2026", time: "1400", location: "CGH", outOfCamp: true, resolved: false });
    const r = st.roster.find(x => x.id === "3405");
    r.outOfCamp = true; r.outSince = DATE; r.outReason = "Appt: Physio";
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/3405 REC LD GUY - MA \(Physio\) \(290626 1400\) OUT @ CGH/.test(section(out, "MA")), "MA line carries the OUT marker: " + section(out, "MA"));
    ok(!/3405/.test(section(out, "OTHERS")), "the same absence is not repeated under OTHERS");
  });

  suite("parade: leave and duty split by section");

  await test("time off files under OFF/LEAVE, duty under OTHERS", () => {
    const st = state();
    st.leave.push(
      { id: 41, d4: "3405", type: "Annual Leave", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "family" },
      { id: 42, d4: "1303", type: "Guard Duty", startDate: "29 Jun 2026", endDate: "29 Jun 2026", reason: "Coy guard" }
    );
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/3405 REC LD GUY - ANNUAL LEAVE \(family\) \(290626-300626\)/.test(section(out, "OFF/LEAVE")), "leave: " + section(out, "OFF/LEAVE"));
    ok(/1303 .* - GUARD DUTY \(Coy guard\) \(290626\)/.test(section(out, "OTHERS")), "guard duty: " + section(out, "OTHERS"));
  });

  await test("Warded files under OTHERS per the battalion's section table", () => {
    const st = state();
    st.medical.push({ d4: "3405", status: "Warded", reason: "Dengue", startDate: "29 Jun 2026", endDate: "03 Jul 2026", inCamp: false, location: "TTSH" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/3405 REC LD GUY - 5D WARDED \(Dengue\) \(290626-030726\) @ TTSH/.test(section(out, "OTHERS")), "warded: " + section(out, "OTHERS"));
    ok(!/3405/.test(section(out, "ATT C")), "Warded is not an ATT C entry");
  });

  await test("restrictions sharing one duration collapse to one line", () => {
    const st = state();
    st.medical.push(
      { d4: "3405", status: "Excuse RMJ", reason: "Back pain", startDate: "29 Jun 2026", endDate: "02 Jul 2026" },
      { d4: "3405", status: "Excuse Heavy Load", reason: "Back pain", startDate: "29 Jun 2026", endDate: "02 Jul 2026" }
    );
    const status = section(loadParade(st).generateParadeStateText("FP", DATE, "0730"), "STATUS");
    ok(/4D EXCUSE RMJ, HEAVY LOAD \(Back pain\) \(290626-020726\)/.test(status), "merged excuses: " + status);
  });

  // ── Back-to-back re-issues ───────────────────────────────
  // An extended MC / a second block of leave is a NEW record starting the day
  // after the last one ends. Reporting the covering record's own end date told
  // the chat the recruit was back days before they actually are.
  suite("parade: chained statuses report the whole run");

  await test("ATT C states the extended MC's real end date and total days", () => {
    const st = state();
    // 1201's away MC is 29 Jun – 01 Jul; extend it with a second record.
    st.medical.push({ d4: "2201", status: "MC", reason: "Flu", startDate: "02 Jul 2026", endDate: "04 Jul 2026", inCamp: false, location: "" });
    const attc = section(loadParade(st).generateParadeStateText("FP", DATE, "0730"), "ATT C");
    ok(/2201 REC AWAY GUY - 6D MC \(Flu\) \(290626-040726\)/.test(attc), "6 days across both records: " + attc);
    eq(attc.split("\n").filter(l => /2201/.test(l)).length, 1, "one line, not two");
  });

  await test("a genuine gap is NOT merged into one run", () => {
    const st = state();
    // Back in camp 02–03 Jul, then a fresh MC — today's absence still ends 01 Jul.
    st.medical.push({ d4: "2201", status: "MC", reason: "Flu", startDate: "04 Jul 2026", endDate: "05 Jul 2026", inCamp: false, location: "" });
    const attc = section(loadParade(st).generateParadeStateText("FP", DATE, "0730"), "ATT C");
    ok(/2201 REC AWAY GUY - 3D MC \(Flu\) \(290626-010726\)/.test(attc), "ends at the real return: " + attc);
  });

  await test("OFF/LEAVE spans back-to-back leave of the same type", () => {
    const st = state();
    st.leave.push(
      { id: 11, d4: "3405", type: "Annual Leave", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "family" },
      { id: 12, d4: "3405", type: "Annual Leave", startDate: "01 Jul 2026", endDate: "02 Jul 2026", reason: "family" }
    );
    const off = section(loadParade(st).generateParadeStateText("FP", DATE, "0730"), "OFF/LEAVE");
    ok(/\(290626-020726\)/.test(off), "leave run merged: " + off);
    eq(off.split("\n").filter(Boolean).length, 1, "one line for one absence");
  });

  await test("strength still counts each body once across a run", () => {
    const st = state();
    st.medical.push({ d4: "2201", status: "MC", reason: "Flu", startDate: "02 Jul 2026", endDate: "04 Jul 2026", inCamp: false, location: "" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/^COMPANY: 2\/3$/m.test(out), "still 2 present, chaining is display-only");
  });

  suite("parade: an enlistee's rank comes from the Roster, not a constant");

  // The failure this pins: "REC" was written literally into the R/N formatter,
  // so a cohort promoted to PTE on posting into unit training still paraded as
  // recruits — against a battalion nominal roll that said otherwise. Rank
  // MOVES; the generator has to read it. In the 40 SAR line the rank sits
  // between the 4D and the name: "2201 PTE AWAY GUY".
  await test("a PTE on the roster parades as PTE", () => {
    const st = state();
    for (const r of st.roster) r.rank = "PTE";
    const txt2 = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/^\d+\. 2201 PTE AWAY GUY - /m.test(txt2), "expected a PTE line: " + section(txt2, "ATT C"));
    ok(!/\bREC\b/.test(txt2), "no line may still say REC: " + txt2);
  });

  await test("a blank rank still falls back to REC", () => {
    // Every row looked like this before the column carried anything, so the
    // fallback is what stops this change blanking the rank for whole platoons.
    const txt2 = loadParade(state()).generateParadeStateText("FP", DATE, "0730");
    ok(/^\d+\. 2201 REC AWAY GUY - /m.test(txt2), "blank rank must render REC: " + section(txt2, "ATT C"));
  });

  await test("rank is read per man, not once for the parade", () => {
    const st = state();
    st.roster.find(r => r.id === "2201").rank = "PTE";   // the away MC in ATT C
    const txt2 = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/^\d+\. 2201 PTE /m.test(txt2), "the promoted man is PTE: " + txt2);
    ok(/^\d+\. 3405 REC /m.test(txt2), "his platoon-mate is untouched: " + txt2);
  });

  await test("a commander is still rank + name with no 4D", () => {
    // A commander's rank is read raw, never through rosterRank: its "REC"
    // fallback is the enlistee default and would file a specialist as a
    // recruit. The 00xx id stays administrative while the rank is there.
    const st = state();
    st.roster.push({ id: "0012", role: "Commander", name: "Section Comd", rank: "3SG" });
    st.medical.push({ d4: "0012", status: "MC", reason: "Flu", startDate: "29 Jun 2026", endDate: "01 Jul 2026", inCamp: false, location: "" });
    const txt2 = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/^\d+\. 3SG SECTION COMD - /m.test(txt2), "commander keeps rank+name: " + txt2);
    ok(!/0012/.test(txt2), "and never shows a 00xx id: " + txt2);
  });

  await test("the whole company promoted: no surface still says REC", () => {
    // The real event this was built for. Every enlistee row carries PTE and
    // the commander keeps his own rank, so the only correct output has no REC
    // in it anywhere - and the commander is untouched, because the split is on
    // role, not on rank.
    const st = state();
    for (const r of st.roster) r.rank = "PTE";
    st.roster.push({ id: "0012", role: "Commander", name: "Section Comd", rank: "3SG" });
    st.medical.push({ d4: "0012", status: "MC", reason: "Flu", startDate: "29 Jun 2026", endDate: "01 Jul 2026", inCamp: false, location: "" });
    const txt2 = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(!/\bREC\b/.test(txt2), "a REC survived a company-wide promotion: " + txt2);
    ok(/\bPTE AWAY GUY\b/.test(txt2), "the enlistees are PTE: " + txt2);
    ok(/\b3SG SECTION COMD\b/.test(txt2), "the commander kept his rank: " + txt2);
  });

  suite("parade: the other two reports read the same column");

  // The Medical Status List and the MSK report are separate generators with
  // their own R/N formatters (paradeRN, and rnNoC which is a near-copy of it).
  // The parade state agreeing with the roster says nothing about either, and
  // "shown as PTE everywhere" means these too.
  const mskState = () => {
    const st = state();
    st.msk = [
      { d4: "2201", type: "Report", description: "Shin splints", timestamp: "2026-06-20T08:00:00Z", cleared: false },
      { d4: "0012", type: "Report", description: "Knee", timestamp: "2026-06-20T08:00:00Z", cleared: false },
    ];
    st.roster.push({ id: "0012", role: "Commander", name: "Section Comd", rank: "3SG" });
    return st;
  };

  await test("the Medical Status List carries the roster rank", () => {
    const st = state();
    for (const r of st.roster) r.rank = "PTE";
    const txt2 = loadParade(st).generateMedicalStatusText(DATE, "0730");
    // The Medical Status List files the in-camp MC and the LD; the away MC is
    // an ATT C line and does not appear here.
    ok(/R\/N: PTE LD GUY C3405/.test(txt2), "expected a PTE R/N line: " + txt2);
    ok(!/\bREC\b/.test(txt2), "no line may still say REC: " + txt2);
  });

  await test("a blank rank still falls back to REC in the Medical Status List", () => {
    const txt2 = loadParade(state()).generateMedicalStatusText(DATE, "0730");
    ok(/R\/N: REC LD GUY C3405/.test(txt2), "blank rank must render REC: " + txt2);
  });

  await test("the MSK report carries the roster rank, and leaves the commander alone", () => {
    const st = mskState();
    for (const r of st.roster) if (r.role !== "Commander") r.rank = "PTE";
    const txt2 = loadParade(st).generateMSKReportText(DATE, "0730");
    ok(/R\/N: PTE AWAY GUY 2201/.test(txt2), "expected a PTE R/N line, 4D with no C: " + txt2);
    ok(/R\/N: 3SG SECTION COMD/.test(txt2), "the commander keeps his own rank: " + txt2);
    ok(!/\bREC\b/.test(txt2), "no line may still say REC: " + txt2);
  });
};
